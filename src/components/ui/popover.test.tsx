import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Popover, PopoverContent, PopoverTrigger } from './popover'

afterEach(cleanup)

describe('Popover', () => {
  it('does not mount content while closed', () => {
    render(
      <Popover open={false}>
        <PopoverTrigger>Open</PopoverTrigger>
        <PopoverContent>Closed content</PopoverContent>
      </Popover>,
    )

    expect(screen.queryByText('Closed content')).toBeNull()
  })

  it('mounts content while open', () => {
    render(
      <Popover open>
        <PopoverTrigger>Open</PopoverTrigger>
        <PopoverContent>Open content</PopoverContent>
      </Popover>,
    )

    expect(screen.getByText('Open content')).toBeTruthy()
  })

  it('mounts closed content when forceMount is explicit', () => {
    render(
      <Popover open={false}>
        <PopoverTrigger>Open</PopoverTrigger>
        <PopoverContent forceMount>Forced content</PopoverContent>
      </Popover>,
    )

    expect(screen.getByText('Forced content')).toBeTruthy()
  })
})
