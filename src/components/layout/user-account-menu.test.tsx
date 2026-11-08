import { cleanup, fireEvent, render } from '@testing-library/react'
import type { AnchorHTMLAttributes, ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UserAccountMenu } from './user-account-menu'

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  signOut: vi.fn(),
}))

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    params,
    ...props
  }: {
    children: ReactNode
    to: string
    params?: { username: string }
  } & AnchorHTMLAttributes<HTMLAnchorElement>) => {
    const href = params?.username ? to.replace('$username', params.username) : to
    return (
      <a href={href} {...props}>
        {children}
      </a>
    )
  },
  useNavigate: () => mocks.navigate,
}))

vi.mock('next-themes', () => ({
  useTheme: () => ({ setTheme: vi.fn(), theme: 'system' }),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { changeLanguage: vi.fn(), resolvedLanguage: 'en' },
    t: (key: string) => key,
  }),
}))

vi.mock('@/lib/auth-client', () => ({
  signOut: mocks.signOut,
  useSession: () => ({
    data: {
      user: {
        image: null,
        name: 'Admin User',
        role: 'admin',
        username: 'admin',
      },
    },
  }),
}))

vi.mock('@/components/ui/sidebar', () => ({
  SidebarMenuButton: ({ children, ...props }: { children: ReactNode; [key: string]: unknown }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('UserAccountMenu', () => {
  it('links to personal settings and admin access without a public profile or teams entry', async () => {
    const view = render(<UserAccountMenu showAdminLink showFrontendLinks />)

    fireEvent.pointerDown(view.getByRole('button', { name: /Admin User/ }), { button: 0, ctrlKey: false })

    expect((await view.findByRole('menuitem', { name: 'nav.settings' })).getAttribute('href')).toBe('/settings')
    expect(view.getByRole('menuitem', { name: 'nav.adminPanel' })).toBeTruthy()
    // The single-admin build has no public user profile pages.
    expect(view.queryByRole('menuitem', { name: 'nav.profile' })).toBeNull()
    expect(view.queryByText('nav.teams')).toBeNull()
  })
})
