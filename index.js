// Forest Survival - multiplayer game server
// One Durable Object instance = one "room" (up to 4 players)

const MAX_PLAYERS = 4;
const DAY_MS = 3 * 60 * 1000;   // 3 min day
const NIGHT_MS = 90 * 1000;     // 1.5 min night
const CYCLE_MS = DAY_MS + NIGHT_MS;
const TREE_COUNT = 90;
const WORLD_RADIUS = 55;

export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map(); // ws -> player
    this.startTime = Date.now();
    this.trees = this.generateTrees();
    this.structures = [];
    this.monsters = [];
    this.tickHandle = null;
  }

  generateTrees() {
    const trees = [];
    let seed = 90210;
    const rand = () => {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    };
    for (let i = 0; i < TREE_COUNT; i++) {
      const ang = rand() * Math.PI * 2;
      const dist = 6 + rand() * (WORLD_RADIUS - 6);
      trees.push({
        id: "tree_" + i,
        x: Math.cos(ang) * dist,
        z: Math.sin(ang) * dist,
        chopped: false,
      });
    }
    return trees;
  }

  isNight() {
    return (Date.now() - this.startTime) % CYCLE_MS > DAY_MS;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== "/ws") return new Response("Game room", { status: 200 });
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 400 });
    }
    if (this.sessions.size >= MAX_PLAYERS) {
      return new Response("room full", { status: 403 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const name = (url.searchParams.get("name") || "Player").slice(0, 16);
    this.acceptSession(server, name);
    return new Response(null, { status: 101, webSocket: client });
  }

  acceptSession(ws, name) {
    ws.accept();
    const id = crypto.randomUUID();
    const player = { id, name, x: 0, y: 0, z: 0, ry: 0, hp: 100, wood: 0 };
    this.sessions.set(ws, player);

    ws.send(
      JSON.stringify({
        type: "init",
        id,
        trees: this.trees,
        structures: this.structures,
        monsters: this.monsters,
        players: [...this.sessions.values()],
        isNight: this.isNight(),
      })
    );
    this.broadcast({ type: "playerJoined", player }, ws);

    if (!this.tickHandle) this.startTick();

    ws.addEventListener("message", (evt) => {
      let msg;
      try {
        msg = JSON.parse(evt.data);
      } catch {
        return;
      }
      this.handleMessage(ws, msg);
    });

    const cleanup = () => {
      if (!this.sessions.has(ws)) return;
      this.sessions.delete(ws);
      this.broadcast({ type: "playerLeft", id });
      if (this.sessions.size === 0 && this.tickHandle) {
        clearInterval(this.tickHandle);
        this.tickHandle = null;
      }
    };
    ws.addEventListener("close", cleanup);
    ws.addEventListener("error", cleanup);
  }

  handleMessage(ws, msg) {
    const player = this.sessions.get(ws);
    if (!player) return;

    if (msg.type === "move") {
      player.x = msg.x;
      player.y = msg.y;
      player.z = msg.z;
      player.ry = msg.ry;
      this.broadcast(
        { type: "playerMoved", id: player.id, x: player.x, y: player.y, z: player.z, ry: player.ry },
        ws
      );
    } else if (msg.type === "chop") {
      const tree = this.trees.find((t) => t.id === msg.treeId && !t.chopped);
      if (tree) {
        tree.chopped = true;
        player.wood += 1;
        this.broadcast({ type: "treeChopped", treeId: tree.id, wood: player.wood, by: player.id });
      }
    } else if (msg.type === "build") {
      if (player.wood >= 5) {
        player.wood -= 5;
        const structure = { id: "st_" + crypto.randomUUID(), x: msg.x, z: msg.z, ry: msg.ry || 0, owner: player.id };
        this.structures.push(structure);
        this.broadcast({ type: "structureBuilt", structure, wood: player.wood });
      }
    } else if (msg.type === "hit") {
      const m = this.monsters.find((mo) => mo.id === msg.monsterId);
      if (m) {
        m.hp -= 25;
        if (m.hp <= 0) {
          this.monsters = this.monsters.filter((mo) => mo.id !== m.id);
          this.broadcast({ type: "monsterKilled", id: m.id });
        } else {
          this.broadcast({ type: "monsterHit", id: m.id, hp: m.hp });
        }
      }
    }
  }

  startTick() {
    this.tickHandle = setInterval(() => {
      const night = this.isNight();
      const cycleT = (Date.now() - this.startTime) % CYCLE_MS;

      if (night) {
        const cap = 2 + this.sessions.size;
        if (this.monsters.length < cap && Math.random() < 0.06) {
          const ang = Math.random() * Math.PI * 2;
          const m = {
            id: "m_" + crypto.randomUUID(),
            x: Math.cos(ang) * WORLD_RADIUS,
            z: Math.sin(ang) * WORLD_RADIUS,
            hp: 50,
          };
          this.monsters.push(m);
          this.broadcast({ type: "monsterSpawned", monster: m });
        }

        for (const m of this.monsters) {
          let nearest = null,
            nd = Infinity;
          for (const p of this.sessions.values()) {
            const d = Math.hypot(p.x - m.x, p.z - m.z);
            if (d < nd) {
              nd = d;
              nearest = p;
            }
          }
          if (nearest && nd > 1.6) {
            const dx = nearest.x - m.x,
              dz = nearest.z - m.z;
            const len = Math.hypot(dx, dz) || 1;
            m.x += (dx / len) * 0.35;
            m.z += (dz / len) * 0.35;
          } else if (nearest) {
            nearest.hp = Math.max(0, nearest.hp - 3);
          }
        }
        this.broadcast({ type: "monstersUpdate", monsters: this.monsters });
      } else if (this.monsters.length) {
        this.monsters = [];
        this.broadcast({ type: "monstersUpdate", monsters: [] });
      }

      this.broadcast({
        type: "tick",
        isNight: night,
        cycleT,
        cycleMs: CYCLE_MS,
        players: [...this.sessions.values()].map((p) => ({ id: p.id, hp: p.hp, wood: p.wood })),
      });
    }, 200);
  }

  broadcast(msg, except) {
    const data = JSON.stringify(msg);
    for (const ws of this.sessions.keys()) {
      if (ws === except) continue;
      try {
        ws.send(data);
      } catch {
        // ignore broken sockets, close handler will clean up
      }
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      const room = url.searchParams.get("room") || "default";
      const id = env.GAME_ROOM.idFromName(room);
      const stub = env.GAME_ROOM.get(id);
      return stub.fetch(request);
    }
    // Everything else is the static client (served from the assets binding)
    return env.ASSETS.fetch(request);
  },
};
