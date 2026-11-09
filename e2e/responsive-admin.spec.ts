import { expect, test } from '@playwright/test'
import { signInAsAdmin } from './helpers'

// ---------------------------------------------------------------------------
// Admin sidebar
// ---------------------------------------------------------------------------
test.describe('Admin sidebar responsive', () => {
  test('desktop: admin sidebar is visible @desktop', async ({ page }) => {
    await signInAsAdmin(page)

    const sidebar = page.locator('[data-slot="sidebar"]')
    await expect(sidebar).toBeVisible()

    const navLinks = await sidebar.locator('a').evaluateAll((links) => links.map((link) => link.getAttribute('href')))
    expect(navLinks).toContain('/admin/storages')
    expect(navLinks).not.toContain('/admin/analytics')
    expect(navLinks).not.toContain('/admin/users')
  })

  test('mobile: admin sidebar opens via trigger @mobile', async ({ page }) => {
    await signInAsAdmin(page)

    const sidebar = page.locator('[data-slot="sidebar"]')
    await expect(sidebar).not.toBeInViewport()

    const trigger = page.locator('button[data-sidebar="trigger"]')
    await expect(trigger).toBeVisible()
    await trigger.click()
    await expect(sidebar).toBeVisible()
  })
})

// ---------------------------------------------------------------------------
// Admin storages page
// ---------------------------------------------------------------------------
test.describe('Admin storages page responsive', () => {
  test('storages page has no horizontal overflow @all', async ({ page }) => {
    await signInAsAdmin(page)

    const hasHScroll = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    )
    expect(hasHScroll).toBe(false)
  })
})
