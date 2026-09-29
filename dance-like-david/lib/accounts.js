// Player accounts: username + password (scrypt-hashed), bearer-token sessions. Stored in DATA/users.json.
import crypto from 'node:crypto';
import path from 'node:path';
import { readJson, writeJson, withLock, httpError } from './fsjson.js';

const SESSION_DAYS = 90;

const hash = (password, salt) => new Promise((resolve, reject) =>
  crypto.scrypt(String(password), salt, 64, (err, key) => (err ? reject(err) : resolve(key.toString('hex')))));

export async function createAccounts(dataDir) {
  const file = path.join(dataDir, 'users.json');
  const db = await readJson(file, { users: {}, sessions: {} });
  const save = () => withLock(file, () => writeJson(file, db));

  const pub = (u) => u && { id: u.id, username: u.username, displayName: u.displayName, createdAt: u.createdAt };
  const norm = (s) => String(s || '').trim().toLowerCase();
  const findByName = (un) => Object.values(db.users).find((u) => u.username === un);

  function newSession(userId) {
    const token = crypto.randomBytes(24).toString('hex');
    db.sessions[token] = { userId, createdAt: Date.now() };
    return token;
  }

  // drop expired sessions on start
  const cutoff = Date.now() - SESSION_DAYS * 864e5;
  for (const [t, s] of Object.entries(db.sessions)) if (s.createdAt < cutoff) delete db.sessions[t];

  return {
    async register({ username, password, displayName }) {
      const un = norm(username);
      if (!/^[a-z0-9_.-]{3,24}$/.test(un)) throw httpError(400, 'Username: 3–24 letters, numbers, _ . or -');
      if (String(password || '').length < 6) throw httpError(400, 'Password must be at least 6 characters');
      if (findByName(un)) throw httpError(409, 'That username is taken');
      const salt = crypto.randomBytes(16).toString('hex');
      const user = {
        id: crypto.randomBytes(6).toString('hex'),
        username: un,
        displayName: String(displayName || username).trim().slice(0, 20) || un,
        salt,
        hash: await hash(password, salt),
        createdAt: new Date().toISOString(),
      };
      db.users[user.id] = user;
      const token = newSession(user.id);
      await save();
      return { token, user: pub(user) };
    },

    async login({ username, password }) {
      const user = findByName(norm(username));
      // compare even when the user doesn't exist, so timing doesn't reveal which usernames are real
      const salt = user?.salt || 'x'.repeat(32);
      const h = Buffer.from(await hash(password || '', salt), 'hex');
      const ok = user && crypto.timingSafeEqual(h, Buffer.from(user.hash, 'hex'));
      if (!ok) throw httpError(401, 'Wrong username or password');
      const token = newSession(user.id);
      await save();
      return { token, user: pub(user) };
    },

    async logout(token) {
      if (db.sessions[token]) { delete db.sessions[token]; await save(); }
    },

    userForToken(token) {
      const s = token && db.sessions[token];
      if (!s || s.createdAt < Date.now() - SESSION_DAYS * 864e5) return null;
      return pub(db.users[s.userId]);
    },

    getUser: (id) => pub(db.users[id]),
    count: () => Object.keys(db.users).length,
  };
}
