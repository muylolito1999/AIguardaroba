import { SignJWT, UnsecuredJWT } from "jose";
import { describe, expect, it } from "vitest";

import { SESSION_TTL_SECONDS, signSessionToken, verifySessionToken } from "./token";

// Obviously fake test secrets, at least 32 characters like the real one.
const SECRET = "test-session-secret-0123456789abcdef";
const OTHER_SECRET = "another-test-secret-0123456789abcdef";
const T0 = new Date("2026-11-02T08:00:00Z");
const key = new TextEncoder().encode(SECRET);

function at(seconds: number): Date {
  return new Date(T0.getTime() + seconds * 1000);
}

/** A token like the real one, with selected parts replaced. */
function craft(options: { alg?: string; iss?: string; aud?: string; sub?: string; ttl?: number } = {}) {
  const iat = Math.floor(T0.getTime() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: options.alg ?? "HS256" })
    .setSubject(options.sub ?? "owner")
    .setIssuer(options.iss ?? "wardrobe")
    .setAudience(options.aud ?? "wardrobe")
    .setIssuedAt(iat)
    .setExpirationTime(iat + (options.ttl ?? SESSION_TTL_SECONDS))
    .sign(key);
}

describe("session tokens", () => {
  it("round-trips the owner session with a 30-day expiry", async () => {
    const token = await signSessionToken(SECRET, T0);
    const payload = await verifySessionToken(token, SECRET, at(60));
    const iat = Math.floor(T0.getTime() / 1000);
    expect(payload).toEqual({ sub: "owner", iat, exp: iat + 30 * 24 * 60 * 60 });
  });

  it("uses HS256 with issuer and audience 'wardrobe'", async () => {
    const [header, body] = (await signSessionToken(SECRET, T0)).split(".");
    expect(JSON.parse(Buffer.from(header ?? "", "base64url").toString())).toMatchObject({ alg: "HS256" });
    expect(JSON.parse(Buffer.from(body ?? "", "base64url").toString())).toMatchObject({
      sub: "owner",
      iss: "wardrobe",
      aud: "wardrobe",
    });
  });

  it("rejects a token signed with another secret", async () => {
    const token = await signSessionToken(OTHER_SECRET, T0);
    expect(await verifySessionToken(token, SECRET, T0)).toBeNull();
  });

  it("rejects a tampered signature or payload", async () => {
    const token = await signSessionToken(SECRET, T0);
    const [header, body, signature] = token.split(".") as [string, string, string];
    const flipped = `${signature.slice(0, -2)}${signature.endsWith("AA") ? "BB" : "AA"}`;
    expect(await verifySessionToken(`${header}.${body}.${flipped}`, SECRET, T0)).toBeNull();

    const forgedBody = Buffer.from(JSON.stringify({ sub: "owner", iss: "wardrobe", aud: "wardrobe", iat: 1, exp: 9_999_999_999 })).toString(
      "base64url",
    );
    expect(await verifySessionToken(`${header}.${forgedBody}.${signature}`, SECRET, T0)).toBeNull();
  });

  it("rejects an unsecured alg 'none' token", async () => {
    const iat = Math.floor(T0.getTime() / 1000);
    const token = new UnsecuredJWT({})
      .setSubject("owner")
      .setIssuer("wardrobe")
      .setAudience("wardrobe")
      .setIssuedAt(iat)
      .setExpirationTime(iat + 3600)
      .encode();
    expect(await verifySessionToken(token, SECRET, T0)).toBeNull();
  });

  it("rejects HS512 even with the right secret", async () => {
    expect(await verifySessionToken(await craft({ alg: "HS512" }), SECRET, T0)).toBeNull();
    // Control: the same construction with HS256 passes.
    expect(await verifySessionToken(await craft(), SECRET, T0)).not.toBeNull();
  });

  it("rejects a wrong audience, issuer or subject", async () => {
    expect(await verifySessionToken(await craft({ aud: "other" }), SECRET, T0)).toBeNull();
    expect(await verifySessionToken(await craft({ iss: "other" }), SECRET, T0)).toBeNull();
    expect(await verifySessionToken(await craft({ sub: "someone" }), SECRET, T0)).toBeNull();
  });

  it("expires after 30 days, judged by the injected current date", async () => {
    const token = await signSessionToken(SECRET, T0);
    expect(await verifySessionToken(token, SECRET, at(SESSION_TTL_SECONDS - 1))).not.toBeNull();
    expect(await verifySessionToken(token, SECRET, at(SESSION_TTL_SECONDS + 1))).toBeNull();
  });

  it("caps the age by iat even when exp is later", async () => {
    const token = await craft({ ttl: SESSION_TTL_SECONDS * 10 });
    expect(await verifySessionToken(token, SECRET, at(SESSION_TTL_SECONDS + 60))).toBeNull();
  });

  it("rejects a token issued in the future", async () => {
    const token = await signSessionToken(SECRET, at(3600));
    expect(await verifySessionToken(token, SECRET, T0)).toBeNull();
  });

  it.each(["", "garbage", "a.b.c", "....", "eyJhbGciOiJIUzI1NiJ9.e30."])("returns null for %j without throwing", async (token) => {
    await expect(verifySessionToken(token, SECRET, T0)).resolves.toBeNull();
  });

  it("returns null when the secret is empty", async () => {
    const token = await signSessionToken(SECRET, T0);
    await expect(verifySessionToken(token, "", T0)).resolves.toBeNull();
  });
});
