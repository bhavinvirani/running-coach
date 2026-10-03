import type { Page } from "@playwright/test";

/**
 * A full-page capture of a page taller than the viewport leaves the sticky tab bar where the viewport ends,
 * over the content. A viewport as tall as the page puts it at the bottom, where a runner who scrolled to
 * the end sees it, and every row stays in the comparison (progress.screen.spec.ts). Call once the last row
 * has rendered.
 */
export async function fitViewportToPage(page: Page): Promise<void> {
  const viewport = page.viewportSize();
  const content = await page.locator("body").boundingBox();
  if (!viewport || !content) throw new Error("The page has no viewport or no laid-out body");
  await page.setViewportSize({ width: viewport.width, height: Math.ceil(content.height) });
}
