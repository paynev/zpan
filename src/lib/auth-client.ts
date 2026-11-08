import { lastLoginMethodClient } from 'better-auth/client/plugins'
import { createAuthClient } from 'better-auth/react'

import { clearSessionCache } from './api'

export const authClient = createAuthClient({
  baseURL: import.meta.env.VITE_API_URL || '',
  plugins: [lastLoginMethodClient()],
})

export const { signIn, useSession } = authClient

// biome-ignore lint/suspicious/noExplicitAny: generic wrapping requires any
function wrapAuthFunction<T extends (...args: any[]) => any>(fn: T): T {
  return new Proxy(fn, {
    apply(target, thisArg, argArray) {
      clearSessionCache()
      return Reflect.apply(target, thisArg, argArray)
    },
  }) as unknown as T
}

export const signOut = wrapAuthFunction(authClient.signOut)
