import { expect, test } from '@playwright/test'

// ---------------------------------------------------------------------------
// Auth pages: the sign-in page should not overflow on any device.
// The single-admin build has no sign-up page.
// ---------------------------------------------------------------------------
test.describe('Auth pages responsive layout', () => {
  test('sign-in page has no horizontal overflow @all', async ({ page }) => {
    await page.goto('/sign-in')
    await expect(page.getByRole('heading', { name: 'ZPan' })).toBeVisible()

    const hasHScroll = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    )
    expect(hasHScroll).toBe(false)
  })

  test('mobile: sign-in form fields are usable @mobile', async ({ page }) => {
    await page.goto('/sign-in')

    const emailInput = page.getByLabel(/email/i)
    const passwordInput = page.getByLabel(/password/i)
    await expect(emailInput).toBeVisible()
    await expect(passwordInput).toBeVisible()

    const submitBtn = page.getByRole('button', { name: /sign in/i })
    await expect(submitBtn).toBeVisible()

    const formOverflows = await page.evaluate(() => {
      const form = document.querySelector('form')
      return form ? form.scrollWidth > form.clientWidth : false
    })
    expect(formOverflows).toBe(false)
  })
})
