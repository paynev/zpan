import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MusicPlayerButton } from './music-player-button'
import { MusicPlayerProvider, type MusicTrack, useMusicPlayer } from './music-player-provider'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('@vidstack/react', () => ({
  MediaPlayer: ({ children, title }: { children: ReactNode; title: string }) => (
    <div data-testid="media-player" data-title={title}>
      {children}
    </div>
  ),
  MediaProvider: () => <div data-testid="media-provider" />,
}))

vi.mock('@vidstack/react/player/layouts/default', () => ({
  DefaultAudioLayout: () => <div data-testid="audio-layout" />,
  defaultLayoutIcons: {},
}))

vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: ({
    children,
    className,
    forceMount,
  }: {
    children: ReactNode
    className?: string
    forceMount?: boolean
  }) => (
    <div data-testid="music-popover" data-force-mount={forceMount ? 'true' : 'false'} className={className}>
      {children}
    </div>
  ),
}))

const getObject = vi.fn()

vi.mock('@/lib/api', () => ({
  getObject: (...args: unknown[]) => getObject(...args),
}))

function makeTrack(overrides: Partial<MusicTrack> = {}): MusicTrack {
  return {
    id: 'track-1',
    name: 'song.mp3',
    type: 'audio/mpeg',
    size: 4096,
    downloadUrl: 'https://example.com/song.mp3',
    ...overrides,
  }
}

function AddTrackButton({ track }: { track: MusicTrack }) {
  const player = useMusicPlayer()
  return (
    <button type="button" onClick={() => player.play(track)}>
      add {track.id}
    </button>
  )
}

function renderButton(tracks: MusicTrack[] = []) {
  return render(
    <MusicPlayerProvider>
      {tracks.map((track) => (
        <AddTrackButton key={track.id} track={track} />
      ))}
      <MusicPlayerButton />
    </MusicPlayerProvider>,
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('MusicPlayerButton', () => {
  it('starts with an empty local playlist', () => {
    const view = renderButton()

    expect(view.getByLabelText('music.player')).toBeTruthy()
    expect(view.getByText('music.emptyHint')).toBeTruthy()
    expect(view.getByText('music.queueEmpty')).toBeTruthy()
    expect(getObject).not.toHaveBeenCalled()
  })

  it('force mounts the popover while hiding its closed state', () => {
    const view = renderButton()
    const popover = view.getByTestId('music-popover')

    expect(popover.dataset.forceMount).toBe('true')
    expect(popover.className).toContain('data-[state=closed]:hidden')
  })

  it('adds a file-browser play request to the local playlist', () => {
    const view = renderButton([makeTrack()])

    fireEvent.click(view.getByText('add track-1'))

    expect(view.getByTestId('media-player').dataset.title).toBe('song.mp3')
    expect(view.getAllByText('song.mp3').length).toBeGreaterThan(0)
    expect(view.getByText('music.unknownArtist')).toBeTruthy()
  })

  it('keeps playlist insertion order when existing tracks are played again', () => {
    const first = makeTrack({ id: 'track-1', name: 'first.mp3' })
    const second = makeTrack({ id: 'track-2', name: 'second.mp3' })
    const view = renderButton([first, second])

    fireEvent.click(view.getByText('add track-1'))
    fireEvent.click(view.getByText('add track-2'))
    fireEvent.click(view.getByText('add track-1'))

    const rows = view.getAllByRole('button').filter((button) => button.textContent?.includes('.mp3'))
    expect(rows.map((row) => row.textContent)).toEqual(['first.mp34.0 KB', 'second.mp34.0 KB'])
  })

  it('selects playlist tracks on single click and plays them on double click', async () => {
    const track = makeTrack()
    getObject.mockResolvedValue({ ...track, downloadUrl: 'https://example.com/fresh.mp3' })
    const view = renderButton([track])

    fireEvent.click(view.getByText('add track-1'))
    fireEvent.click(view.getAllByText('song.mp3').at(-1)!)

    expect(getObject).not.toHaveBeenCalled()

    fireEvent.doubleClick(view.getAllByText('song.mp3').at(-1)!)

    await waitFor(() => expect(getObject).toHaveBeenCalledWith('track-1'))
    expect(view.getByTestId('media-player').dataset.title).toBe('song.mp3')
  })
})
