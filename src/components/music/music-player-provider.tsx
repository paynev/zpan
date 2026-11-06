import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react'
import type { PreviewFile } from '@/components/preview/file-preview-content'

export interface MusicTrack extends PreviewFile {
  artist?: string
  album?: string
  coverUrl?: string
}

interface MusicPlayerContextValue {
  currentTrack: MusicTrack | null
  selectedTrack: MusicTrack | null
  playlist: MusicTrack[]
  open: boolean
  setOpen: (open: boolean) => void
  select: (track: MusicTrack) => void
  play: (track: MusicTrack) => void
}

const MusicPlayerContext = createContext<MusicPlayerContextValue | null>(null)

export function MusicPlayerProvider({ children }: { children: ReactNode }) {
  const [currentTrack, setCurrentTrack] = useState<MusicTrack | null>(null)
  const [selectedTrack, setSelectedTrack] = useState<MusicTrack | null>(null)
  const [playlist, setPlaylist] = useState<MusicTrack[]>([])
  const [open, setOpen] = useState(false)
  const select = useCallback((track: MusicTrack) => {
    setSelectedTrack(track)
  }, [])
  const play = useCallback((track: MusicTrack) => {
    setCurrentTrack(track)
    setSelectedTrack(track)
    setPlaylist((tracks) => (tracks.some((item) => item.id === track.id) ? tracks : [...tracks, track]))
    setOpen(true)
  }, [])

  const value = useMemo(
    () => ({
      currentTrack,
      selectedTrack,
      playlist,
      open,
      setOpen,
      select,
      play,
    }),
    [currentTrack, selectedTrack, playlist, open, select, play],
  )

  return <MusicPlayerContext.Provider value={value}>{children}</MusicPlayerContext.Provider>
}

export function useMusicPlayer() {
  const value = useContext(MusicPlayerContext)
  if (!value) throw new Error('useMusicPlayer must be used within MusicPlayerProvider')
  return value
}
