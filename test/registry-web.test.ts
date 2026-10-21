import {expect, it} from "vitest";
import {runInDurableObject} from "cloudflare:test";
import {admin, call, control, convertFixture, createRoom, fixture, history, hostedStub, nodeA, nodeB, ORIGIN, registrySql, rf, socket, crypto, joinRoom, sockets} from "./registry-helpers";
import {toHex, fromHex} from "../src/native-crypto";

const device = (n: number) => n.toString(16).padStart(64, "0");
const webCall = (alias: string, path: string, init: {cookie?: string; body?: unknown; ip?: string} = {}) =>
  call(`/v1/web/rooms/${alias}/${path}`, {
    ...(init.body === undefined ? {} : {method: "POST", body: JSON.stringify(init.body)}), ip: init.ip,
    headers: {Origin: ORIGIN, "Content-Type": "application/json", ...(init.cookie ? {Cookie: init.cookie} : {})},
  });
async function webJoin(alias: string, n = 1, name = "Alice", password = "room"): Promise<string> {
  const r = await webCall(alias, "login", {body: {identity: device(n), name, password}});
  expect(r.status, await r.clone().text()).toBe(200);
  return r.headers.get("Set-Cookie")!.split(";")[0];
}
async function webHistory(alias: string, cookie: string): Promise<any[]> {
  const r = await webCall(alias, "history", {cookie});
  expect(r.status).toBe(200);
  return (await r.json<any>()).messages;
}
const post = (alias: string, cookie: string, text: string) =>
  webCall(alias, "posts", {cookie, body: {id: crypto_uuid(), text}});
const crypto_uuid = (): string => globalThis.crypto.randomUUID();

it("shares one history between a browser and a radio frontend on a hosted room", async () => {
  const room = await convertFixture(nodeA, "room");
  const s = await socket(room.alias, room.token);
  await s.next("ready");
  const cookie = await webJoin(room.alias);
  await rf(room.alias, room.token, fixture.readerLogin);
  await rf(room.alias, room.token, fixture.path);
  await rf(room.alias, room.token, fixture.authorLogin);
  await rf(room.alias, room.token, fixture.post);
  const received = history(await s.next("history"));
  expect(received.text).toBe("hello");
  await rf(room.alias, room.token, received.ack);
  // The radio post is in the web history, and a web post reaches the radio reader.
  expect((await webHistory(room.alias, cookie)).map(m => m.text)).toEqual(["hello"]);
  const posted = await post(room.alias, cookie, "from the web");
  expect(posted.status, await posted.clone().text()).toBe(200);
  const next = history(await s.next("history"));
  expect(next.text).toBe("Alice: from the web");
  expect((await webHistory(room.alias, cookie)).map(m => m.text)).toEqual(["hello", "Alice: from the web"]);
  // A second browser sees the same ordered history.
  const other = await webJoin(room.alias, 2, "Bob");
  expect((await webHistory(room.alias, other)).map(m => m.text)).toEqual(["hello", "Alice: from the web"]);
});

it("streams hosted room messages to a browser socket", async () => {
  const room = await convertFixture(nodeA, "room");
  const cookie = await webJoin(room.alias, 1, "Alice");
  const r = await call(`/v1/web/rooms/${room.alias}/socket?since=0`, {headers: {Origin: ORIGIN, Cookie: cookie, Upgrade: "websocket",
    "Sec-WebSocket-Protocol": "aspen-room.web.v1"}});
  expect(r.status).toBe(101);
  const ws = r.webSocket!;
  sockets.push(ws);
  const events: any[] = [], waiting: Array<(e: any) => void> = [];
  ws.addEventListener("message", e => {const v = JSON.parse(e.data as string); if (waiting.length) waiting.shift()!(v); else events.push(v);});
  ws.accept();
  const next = (): Promise<any> => events.length ? Promise.resolve(events.shift()) :
    new Promise((resolve, reject) => {const t = setTimeout(() => reject(new Error("Missing web event")), 2000); waiting.push(v => {clearTimeout(t); resolve(v);});});
  expect(await next()).toMatchObject({type: "ready", alias: room.alias, publicKey: fixture.room.publicKey});
  await rf(room.alias, room.token, fixture.authorLogin);
  await rf(room.alias, room.token, fixture.post);
  const event = await next();
  expect(event).toMatchObject({type: "message", message: {text: "hello"}});
});

it("shares one history across two radio frontends and the web", async () => {
  const room = await convertFixture(nodeA, "room");
  const second = await joinRoom(room, nodeB);
  const a = await socket(room.alias, room.token), b = await socket(room.alias, second.token);
  await a.next("ready"); await b.next("ready");
  const cookie = await webJoin(room.alias);
  expect((await post(room.alias, cookie, "one")).status).toBe(200);
  expect((await post(room.alias, cookie, "two")).status).toBe(200);
  expect((await webHistory(room.alias, cookie)).map(m => m.text)).toEqual(["Alice: one", "Alice: two"]);
  // Revoking one radio frontend leaves the web session and the other frontend working.
  expect((await control(room.alias, room.token, {op: "revoke", id: nodeB.pub.slice(0, 8)})).status).toBe(200);
  expect((await post(room.alias, cookie, "three")).status).toBe(200);
});

it("refuses web access to hosted rooms that are wrong, disabled or deleted", async () => {
  const room = await createRoom(nodeA, "Fleet");
  const password = (await control(room.alias, room.token, {op: "password", mode: "get"})).body.pw;
  expect((await webCall(room.alias, "login", {body: {identity: device(1), name: "Alice", password: "wrong"}})).status).toBe(403);
  const cookie = await webJoin(room.alias, 1, "Alice", password);
  // An alias with a bad tag never reaches storage; a missing room is not found.
  expect((await webCall("r" + "a".repeat(29), "login", {body: {identity: device(1), name: "Alice", password}})).status).toBe(404);
  expect((await webCall("Unknown", "session", {cookie})).status).toBe(404);
  expect((await admin("room", {alias: room.alias, action: "disable"}, "203.0.113.9")).status).toBe(200);
  expect((await webCall(room.alias, "session", {cookie})).status).toBe(403);
  expect((await post(room.alias, cookie, "late")).status).toBe(403);
  expect((await admin("room", {alias: room.alias, action: "enable"}, "203.0.113.9")).status).toBe(200);
  expect((await webCall(room.alias, "session", {cookie})).status).toBe(200);
  expect((await admin("room", {alias: room.alias, action: "delete"}, "203.0.113.9")).status).toBe(200);
  expect((await webCall(room.alias, "session", {cookie})).status).toBe(403);
});

it("limits posts per browser and counts them against the room's daily budget", async () => {
  const room = await createRoom(nodeA, "Busy");
  const password = (await control(room.alias, room.token, {op: "password", mode: "get"})).body.pw;
  const cookie = await webJoin(room.alias, 1, "Alice", password);
  let refused = 0;
  for (let i = 0; i < 31; i++) if ((await post(room.alias, cookie, `m${i}`)).status === 429) ++refused;
  expect(refused).toBe(1);
});

it("lists hosted rooms on the sign-in page only when the operator shows them", async () => {
  const room = await createRoom(nodeA, "Listed Room");
  const ids = async () => (await (await call("/v1/web/rooms")).json<any>()).rooms.map((r: any) => r.id);
  expect(await ids()).toEqual(["S", "T"]);
  expect((await admin("web", {alias: room.alias, action: "show"}, "203.0.113.8")).status).toBe(200);
  const listed = (await (await call("/v1/web/rooms")).json<any>()).rooms.find((r: any) => r.id === room.alias);
  expect(listed).toEqual({id: room.alias, name: "Listed Room", publicKey: expect.stringMatching(/^[a-f0-9]{64}$/)});
  expect((await registrySql("SELECT listed FROM rooms WHERE alias=?", room.alias))[0].listed).toBe(1);
  // A disabled room drops off the page; hiding removes it for good.
  await admin("room", {alias: room.alias, action: "disable"}, "203.0.113.8");
  expect(await ids()).toEqual(["S", "T"]);
  await admin("room", {alias: room.alias, action: "enable"}, "203.0.113.8");
  expect(await ids()).toContain(room.alias);
  expect((await admin("web", {alias: room.alias, action: "hide"}, "203.0.113.8")).status).toBe(200);
  expect(await ids()).toEqual(["S", "T"]);
  // Refusals: a malformed id, an unknown room, a bad action.
  expect((await admin("web", {alias: "TestA", action: "show"}, "203.0.113.8")).body.e).toBe("bad_request");
  expect((await admin("web", {alias: "r" + "a".repeat(29), action: "show"}, "203.0.113.8")).body.e).toBe("not_found");
  expect((await admin("web", {alias: room.alias, action: "list"}, "203.0.113.8")).body.e).toBe("bad_request");
  // Deleting a listed room removes the listing with the room.
  await admin("web", {alias: room.alias, action: "show"}, "203.0.113.8");
  await admin("room", {alias: room.alias, action: "delete"}, "203.0.113.8");
  expect(await ids()).toEqual(["S", "T"]);
});

it("signs in to a hosted room with an operator-granted account and refuses accounts without the grant", async () => {
  const room = await createRoom(nodeA, "Granted");
  const salt = "0a".repeat(16), password = "a long account password";
  const key = await globalThis.crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await globalThis.crypto.subtle.deriveBits({name: "PBKDF2", hash: "SHA-256", salt: fromHex(salt) as BufferSource, iterations: 100000}, key, 256);
  const record = (aliases: string[]) => ({name: "Alice", salt, hash: toHex(new Uint8Array(bits)), iterations: 100000, aliases});
  const users = {alice: record([room.alias]), bob: record(["S"])};
  const env = {WEB_USERS: JSON.stringify(users)};
  await runInDurableObject(hostedStub(room.alias), (inst: any) => {inst.env = {...inst.env, ...env};});
  const device1 = crypto.seed(new Uint8Array(32).fill(0x44));
  const signIn = async (user: string) => {
    const publicKey = toHex(device1.publicKey);
    const challenge = await call(`/v1/web/rooms/${room.alias}/challenge`, {method: "POST", env,
      headers: {Origin: ORIGIN, "Content-Type": "application/json"}, body: JSON.stringify({username: user, publicKey})});
    if (challenge.status !== 200) return challenge;
    const {nonce, message} = await challenge.json<any>();
    const signature = toHex(crypto.sign(device1.key, new TextEncoder().encode(message)));
    return call(`/v1/web/rooms/${room.alias}/login`, {method: "POST", env, headers: {Origin: ORIGIN, "Content-Type": "application/json"},
      body: JSON.stringify({username: user, publicKey, nonce, signature, password})});
  };
  const granted = await signIn("alice");
  expect(granted.status, await granted.clone().text()).toBe(200);
  const cookie = granted.headers.get("Set-Cookie")!.split(";")[0];
  expect((await post(room.alias, cookie, "hello from alice")).status).toBe(200);
  expect([(await signIn("bob")).status]).toEqual([403]);
});
