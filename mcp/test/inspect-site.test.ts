import { describe, expect, it, vi } from "vitest";
import { createSafeLookup, inspectSite } from "../src/site/inspect-site.js";

const publicUrl = "https://93.184.216.34/";

describe("inspectSite", () => {
  it("revalidates DNS answers at connection time", async () => {
    const unsafeLookup = createSafeLookup(async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]);
    const safeLookup = createSafeLookup(async () => [{ address: "93.184.216.34", family: 4 }]);

    await expect(new Promise<string>((resolve, reject) => {
      unsafeLookup("example.test", { all: false }, (error, address) => {
        if (error) reject(error);
        else resolve(String(address));
      });
    })).rejects.toThrow(/unsafe network address/);

    await expect(new Promise<string>((resolve, reject) => {
      safeLookup("example.test", { all: false }, (error, address) => {
        if (error) reject(error);
        else resolve(String(address));
      });
    })).resolves.toBe("93.184.216.34");
  });

  it("requires explicit authorization", async () => {
    await expect(inspectSite({ url: publicUrl, authorizationConfirmed: false })).rejects.toThrow(/permission/);
  });

  it("returns a bounded public HTML design summary", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(`<!doctype html>
      <html lang="en"><head>
        <title>Example Studio</title>
        <meta name="description" content="An example design studio">
        <style>body { color: #123456; font-family: Inter, sans-serif; }</style>
      </head><body>
        <header><nav><a href="/work">Our Work</a></nav></header>
        <main style="background: rgb(1, 2, 3)">
          <h1>Design with care</h1><h2>Selected projects</h2>
          <img src="/hero.jpg" alt="Studio desk"><form></form>
          <script>privateImplementation()</script>
        </main>
      </body></html>`, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    }));

    const result = await inspectSite({ url: publicUrl, authorizationConfirmed: true, fetcher });

    expect(result.title).toBe("Example Studio");
    expect(result.description).toBe("An example design studio");
    expect(result.headings).toEqual([
      { level: 1, text: "Design with care" },
      { level: 2, text: "Selected projects" },
    ]);
    expect(result.navigation).toEqual([{ text: "Our Work", url: `${publicUrl}work` }]);
    expect(result.images).toEqual([{ alt: "Studio desk", url: `${publicUrl}hero.jpg` }]);
    expect(result.colors).toEqual(expect.arrayContaining(["#123456", "rgb(1, 2, 3)"]));
    expect(result.fontFamilies).toContain("Inter, sans-serif");
    expect(result.forms).toBe(1);
    expect(result.textSample).not.toContain("privateImplementation");
    expect(fetcher).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ redirect: "manual" }));
  });

  it("revalidates redirects to prevent SSRF", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, {
      status: 302,
      headers: { location: "http://127.0.0.1/admin" },
    }));

    await expect(inspectSite({ url: publicUrl, authorizationConfirmed: true, fetcher })).rejects.toThrow(/unsafe network address/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects non-HTML and oversized responses", async () => {
    const nonHtml = vi.fn().mockResolvedValue(new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    await expect(inspectSite({ url: publicUrl, authorizationConfirmed: true, fetcher: nonHtml })).rejects.toThrow(/HTML document/);

    const oversized = vi.fn().mockResolvedValue(new Response("small", {
      status: 200,
      headers: { "content-type": "text/html", "content-length": String(2 * 1024 * 1024 + 1) },
    }));
    await expect(inspectSite({ url: publicUrl, authorizationConfirmed: true, fetcher: oversized })).rejects.toThrow(/2 MB/);
  });
});
