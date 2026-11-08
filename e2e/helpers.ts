import { expect, type Page, test } from '@playwright/test'

export const ADMIN_EMAIL = 'e2e-admin@test.local'
export const ADMIN_PASSWORD = 'password123456'

export async function expandSignInForm(page: Page) {
  const identityInput = page.locator('#identity')
  if (await identityInput.isVisible().catch(() => false)) return
  const expandButton = page.getByRole('button', { name: /sign in with email|使用邮箱登录/i })
  if (await expandButton.isVisible().catch(() => false)) await expandButton.click()
  await expect(identityInput).toBeVisible()
}

export async function signInAsAdmin(page: Page) {
  await page.goto('/sign-in')
  await expandSignInForm(page)
  await page.locator('#identity').fill(ADMIN_EMAIL)
  await page.locator('#password').fill(ADMIN_PASSWORD)
  const responsePromise = page.waitForResponse((response) => response.url().includes('/api/auth/sign-in'))
  await page.getByRole('button', { name: /sign in/i }).click()
  expect((await responsePromise).status()).toBe(200)
  await expect(page).toHaveURL(/files/, { timeout: 10_000 })
  await page.goto('/admin/storages')
  await expect(page).toHaveURL(/admin\/storages/)
}

// Single-admin instances have no self-service sign-up. Suite helpers still call
// this by its historical name; it now signs in as the seeded administrator and
// leaves the browser on the file manager.
export async function signUpAndGoToFiles(page: Page) {
  await page.goto('/sign-in')
  await expandSignInForm(page)
  await page.locator('#identity').fill(ADMIN_EMAIL)
  await page.locator('#password').fill(ADMIN_PASSWORD)
  const responsePromise = page.waitForResponse((response) => response.url().includes('/api/auth/sign-in'))
  await page.getByRole('button', { name: /sign in/i }).click()
  expect((await responsePromise).status()).toBe(200)
  await expect(page).toHaveURL(/files/, { timeout: 10_000 })
}

export async function expandSignUpForm(page: Page) {
  await expandSignInForm(page)
}

export async function createFolder(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: /new folder|folder/i }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('textbox').fill(name)
  const responsePromise = page.waitForResponse(
    (response) => response.url().includes('/api/objects') && response.request().method() === 'POST',
  )
  await dialog.getByRole('button', { name: /create/i }).click()
  const response = await responsePromise
  expect(response.ok(), `folder creation failed (${response.status()}) — ensure storage is configured`).toBe(true)
  await expect(dialog).not.toBeVisible({ timeout: 10_000 })
}

export async function getJson<T>(page: Page, url: string): Promise<T> {
  return browserJson<T>(page, 'GET', url)
}

export async function postJson<T>(page: Page, url: string, data?: unknown): Promise<T> {
  return browserJson<T>(page, 'POST', url, data)
}

async function browserJson<T>(page: Page, method: 'GET' | 'POST', url: string, data?: unknown): Promise<T> {
  return (await page.evaluate(
    async ({ method, url, data }) => {
      const response = await fetch(url, {
        method,
        headers: data === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: data === undefined ? undefined : JSON.stringify(data),
      })
      const text = await response.text()
      if (!response.ok) throw new Error(`${method} ${url} failed with ${response.status}: ${text}`)
      return text ? JSON.parse(text) : null
    },
    { method, url, data },
  )) as T
}

export function testIdentity(prefix: string) {
  const id = test
    .info()
    .testId.replace(/[^a-z0-9]+/gi, '')
    .toLowerCase()
  return `${prefix}${id.slice(-20)}`
}
