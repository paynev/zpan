import { expect, test } from '@playwright/test'
import { ADMIN_EMAIL, ADMIN_PASSWORD, expandSignInForm, signUpAndGoToFiles } from './helpers'

test.describe('Auth flow', () => {
  test('redirects to sign-in when not authenticated @all', async ({ page }) => {
    await page.goto('/')
    await expect(page).toHaveURL(/sign-in/, { timeout: 5000 })
  })

  test('sign-in with the seeded administrator and redirect to files @all', async ({ page }) => {
    await page.goto('/sign-in')
    await expect(page.getByRole('heading', { name: 'ZPan' })).toBeVisible()

    await expandSignInForm(page)
    await page.locator('#identity').fill(ADMIN_EMAIL)
    await page.locator('#password').fill(ADMIN_PASSWORD)

    const [response] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/auth/sign-in')),
      page.getByRole('button', { name: /sign in/i }).click(),
    ])
    expect(response.status()).toBe(200)

    await expect(page).toHaveURL(/files/, { timeout: 10_000 })
  })

  test('sign-in with existing account @all @critical', async ({ page }) => {
    await signUpAndGoToFiles(page)

    await page.context().clearCookies()
    await page.goto('/sign-in')
    await expandSignInForm(page)
    await page.locator('#identity').fill(ADMIN_EMAIL)
    await page.locator('#password').fill(ADMIN_PASSWORD)

    const [signInResp] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/auth/sign-in')),
      page.getByRole('button', { name: 'Sign in' }).click(),
    ])
    expect(signInResp.status()).toBe(200)

    await expect(page).toHaveURL(/files/, { timeout: 10_000 })

    await page.goto('/sign-in')
    await expect(page.getByText('Last used')).toBeVisible()
  })

  test('sidebar shows My Files and Trash @desktop @tablet', async ({ page }) => {
    await signUpAndGoToFiles(page)

    const sidebar = page.locator('[data-slot="sidebar"]')
    await expect(sidebar.getByText('My Files')).toBeVisible()
    await expect(sidebar.getByText('Trash')).toBeVisible()
  })
})
