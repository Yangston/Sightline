import { expect, test } from "@playwright/test";

test("landing page explains the product and exposes the dataset", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: /Return to the original/ }),
  ).toBeVisible();
  await expect(page.getByText("149", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Explore reconstructions" }).click();
  await expect(page).toHaveURL(/\/explore$/);
  await expect(page.locator(".scene-card")).toHaveCount(10);
});

test("San Francisco restores the image-only method without eager Cesium", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.goto(
    "/explore/san-francisco?reconstruction=image-only&photo=img-7540",
  );
  const experience = page.locator("[data-city-map-experience]");
  await expect(experience).toHaveAttribute(
    "data-reconstruction-method",
    "image-only",
  );
  await expect(
    page.getByRole("button", { name: "Image-only (no file metadata)" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('[data-photo-id="img-7540"]')).toContainText(
    "Outside image-only pilot area",
  );
  expect(requests.some((url) => /scene\.json|\/cesium\//i.test(url))).toBe(
    false,
  );
});

test("gallery-only scenes retain complete durable photographs", async ({
  page,
}) => {
  await page.goto("/explore/elora");
  await expect(page.locator("[data-city-map-experience]")).toHaveCount(0);
  await expect(page.locator("[data-gallery-ready='true']")).toBeVisible();
  await expect(page.locator("[data-manifest-id]")).toHaveCount(1);
});

test("development calibration routes are production-safe redirects", async ({
  request,
}) => {
  const production = process.env.PLAYWRIGHT_USE_PREVIEW === "1";
  for (const route of [
    "/photography/calibrate",
    "/photography/auto-calibration",
  ]) {
    const response = await request.get(route, { maxRedirects: 0 });
    if (!production) {
      expect(response.status()).toBe(200);
      const html = await response.text();
      expect(html).toContain(
        route.endsWith("auto-calibration")
          ? "Automatic Sightline calibration harness"
          : "Pose calibration",
      );
      continue;
    }
    expect([200, 301, 302, 307, 308, 404]).toContain(response.status());
    if (response.status() === 200) {
      const html = await response.text();
      expect(html).toContain("Redirecting to: /404");
      expect(html).not.toContain("data-auto-calibration-ready");
      expect(html).not.toContain("Development-only camera pose calibration");
    }
  }
});
