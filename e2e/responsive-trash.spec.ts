import { expect, test } from '@playwright/test'
import { signUpAndGoToFiles } from './helpers'

// Helper: sign in as the seeded administrator and go to the recycle bin.
async function goToTrash(page: import('@playwright/test').Page) {
  await signUpAndGoToFiles(page)
  await page.goto('/trash')
  await expect(page).toHaveURL(/trash/, { timeout: 10000 })
}

// ---------------------------------------------------------------------------
// Recycle bin page responsive
// ---------------------------------------------------------------------------
test.describe('Recycle bin responsive layout', () => {
  test('recycle bin has no horizontal overflow @all', async ({ page }) => {
    await goToTrash(page)

    const hasHScroll = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    )
    expect(hasHScroll).toBe(false)
  })

  test('mobile: empty trash action is accessible @mobile', async ({ page }) => {
    await goToTrash(page)

    await expect(page.getByRole('button', { name: /empty/i })).toBeVisible()
  })
})
