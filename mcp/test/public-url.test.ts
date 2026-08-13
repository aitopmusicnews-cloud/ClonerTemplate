import { describe, expect, it } from "vitest";
import { assertPublicHttpUrl, isPublicIp } from "../src/security/public-url.js";

describe("public URL validation", () => {
  it.each([
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "198.51.100.4",
    "::1",
    "fd00::1",
    "fe80::1",
    "2001:db8::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "64:ff9b::7f00:1",
    "100::1",
    "3fff::1",
    "5f00::1",
  ])("blocks unsafe address %s", (address) => {
    expect(isPublicIp(address)).toBe(false);
  });

  it.each(["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"])("accepts public address %s", (address) => {
    expect(isPublicIp(address)).toBe(true);
  });

  it("blocks unsafe DNS answers and IPv6 literals", async () => {
    await expect(assertPublicHttpUrl("https://example.test", async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ])).rejects.toThrow(/unsafe network address/);
    await expect(assertPublicHttpUrl("http://[::1]/")).rejects.toThrow(/unsafe network address/);
  });

  it("accepts safe DNS answers and standard ports", async () => {
    const url = await assertPublicHttpUrl("https://example.test:443/path", async () => [
      { address: "93.184.216.34", family: 4 },
    ]);

    expect(url.pathname).toBe("/path");
  });

  it.each([
    "file:///etc/passwd",
    "https://user:secret@example.com",
    "http://example.com:8080",
  ])("rejects unsafe URL form %s", async (url) => {
    await expect(assertPublicHttpUrl(url, async () => [{ address: "93.184.216.34", family: 4 }])).rejects.toThrow();
  });
});
