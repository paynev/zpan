import { CheckCircle2, Loader2, UploadCloud, X, XCircle } from 'lucide-react'
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Progress } from '@/components/ui/progress'
import { Separator } from '@/components/ui/separator'
import { formatSize } from '@/lib/format'
import { cn } from '@/lib/utils'

const MAX_CONCURRENT_UPLOADS = 3

export type UploadTaskStatus =
  | 'queued'
  | 'preparing'
  | 'uploading'
  | 'confirming'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface UploadProgressUpdate {
  loaded: number
  total: number
}

export interface UploadRunnerContext {
  signal: AbortSignal
  onProgress: (progress: UploadProgressUpdate) => void
  setStatus: (status: UploadTaskStatus) => void
  registerCleanup: (cleanup: () => Promise<void>) => void
}

export interface UploadQueueItemInput {
  file: File
  run: (ctx: UploadRunnerContext) => Promise<void>
}

export interface UploadTask {
  id: string
  fileName: string
  size: number
  status: UploadTaskStatus
  loaded: number
  total: number
  speed: number
  etaSeconds: number | null
  error?: string
  createdAt: number
  updatedAt: number
}

interface InternalUploadTask extends UploadTask {
  run: (ctx: UploadRunnerContext) => Promise<void>
  controller?: AbortController
  cleanup?: () => Promise<void>
}

interface UploadQueueContextValue {
  tasks: UploadTask[]
  isOpen: boolean
  setOpen: (open: boolean) => void
  enqueue: (items: UploadQueueItemInput[], onBatchComplete?: (hadSuccess: boolean) => void) => void
  cancel: (id: string) => void
  cancelAll: () => void
  hasActiveUploads: boolean
}

const UploadQueueContext = createContext<UploadQueueContextValue | null>(null)

function isActive(status: UploadTaskStatus) {
  return status === 'queued' || status === 'preparing' || status === 'uploading' || status === 'confirming'
}

function isRunning(status: UploadTaskStatus) {
  return status === 'preparing' || status === 'uploading' || status === 'confirming'
}

function makeTaskId() {
  return `upload_${Date.now()}_${Math.random().toString(36).slice(2)}`
}

function isAbortError(err: unknown) {
  return err instanceof DOMException && err.name === 'AbortError'
}

export function UploadQueueProvider({ children }: { children: ReactNode }) {
  const [tasks, setTasks] = useState<UploadTask[]>([])
  const [isOpen, setOpen] = useState(false)
  const tasksRef = useRef<InternalUploadTask[]>([])
  const batchCallbacksRef = useRef<Map<string, { ids: Set<string>; onDone: (hadSuccess: boolean) => void }>>(new Map())

  const publish = useCallback(() => {
    setTasks(
      tasksRef.current.map(({ run: _run, controller: _controller, cleanup: _cleanup, ...task }) => ({
        ...task,
      })),
    )
  }, [])

  const updateTask = useCallback(
    (id: string, patch: Partial<InternalUploadTask>) => {
      const task = tasksRef.current.find((item) => item.id === id)
      if (!task) return
      Object.assign(task, patch, { updatedAt: Date.now() })
      publish()
    },
    [publish],
  )

  const settleBatches = useCallback(() => {
    for (const [batchId, batch] of batchCallbacksRef.current) {
      const batchTasks = tasksRef.current.filter((task) => batch.ids.has(task.id))
      if (batchTasks.length === 0 || batchTasks.some((task) => isActive(task.status))) continue
      batchCallbacksRef.current.delete(batchId)
      batch.onDone(batchTasks.some((task) => task.status === 'completed'))
    }
  }, [])

  const maybeStartNext = useCallback(() => {
    const runningCount = tasksRef.current.filter((task) => isRunning(task.status)).length
    const slots = MAX_CONCURRENT_UPLOADS - runningCount
    if (slots <= 0) return

    const nextTasks = tasksRef.current.filter((task) => task.status === 'queued').slice(0, slots)
    for (const task of nextTasks) {
      const controller = new AbortController()
      task.controller = controller
      task.status = 'preparing'
      task.updatedAt = Date.now()

      const startedAt = Date.now()
      task
        .run({
          signal: controller.signal,
          onProgress: (progress) => {
            const now = Date.now()
            const loaded = Math.max(0, Math.min(progress.loaded, progress.total || task.size))
            const total = progress.total || task.size
            const seconds = Math.max((now - startedAt) / 1000, 0.001)
            const speed = loaded / seconds
            const remaining = Math.max(total - loaded, 0)
            updateTask(task.id, {
              loaded,
              total,
              speed,
              etaSeconds: speed > 0 && remaining > 0 ? remaining / speed : null,
            })
          },
          setStatus: (status) => {
            updateTask(task.id, { status })
            if (status === 'uploading') setOpen(true)
          },
          registerCleanup: (cleanup) => updateTask(task.id, { cleanup }),
        })
        .then(() => {
          updateTask(task.id, {
            status: controller.signal.aborted ? 'cancelled' : 'completed',
            loaded: task.total,
            speed: 0,
            etaSeconds: null,
          })
        })
        .catch((err) => {
          updateTask(task.id, {
            status: controller.signal.aborted || isAbortError(err) ? 'cancelled' : 'failed',
            error: err instanceof Error ? err.message : String(err),
            speed: 0,
            etaSeconds: null,
          })
        })
        .finally(async () => {
          if (controller.signal.aborted && task.cleanup) {
            await task.cleanup().catch(() => undefined)
          }
          task.controller = undefined
          settleBatches()
          maybeStartNext()
        })
    }
    publish()
  }, [publish, settleBatches, updateTask])

  const enqueue = useCallback(
    (items: UploadQueueItemInput[], onBatchComplete?: (hadSuccess: boolean) => void) => {
      if (items.length === 0) return
      const newTasks: InternalUploadTask[] = items.map((item) => ({
        id: makeTaskId(),
        fileName: item.file.name,
        size: item.file.size,
        status: 'queued',
        loaded: 0,
        total: item.file.size,
        speed: 0,
        etaSeconds: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        run: item.run,
      }))
      tasksRef.current = [...newTasks, ...tasksRef.current]
      if (onBatchComplete) {
        batchCallbacksRef.current.set(makeTaskId(), {
          ids: new Set(newTasks.map((task) => task.id)),
          onDone: onBatchComplete,
        })
      }
      setOpen(true)
      publish()
      maybeStartNext()
    },
    [maybeStartNext, publish],
  )

  const cancel = useCallback(
    (id: string) => {
      const task = tasksRef.current.find((item) => item.id === id)
      if (!task || !isActive(task.status)) return
      if (task.status === 'queued') {
        updateTask(id, { status: 'cancelled' })
        settleBatches()
        return
      }
      task.controller?.abort()
      updateTask(id, { status: 'cancelled' })
    },
    [settleBatches, updateTask],
  )

  const cancelAll = useCallback(() => {
    for (const task of tasksRef.current) {
      if (isActive(task.status)) cancel(task.id)
    }
  }, [cancel])

  const hasActiveUploads = tasks.some((task) => isActive(task.status))

  useEffect(() => {
    if (!hasActiveUploads) return
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      cancelAll()
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [cancelAll, hasActiveUploads])

  const value = useMemo(
    () => ({ tasks, isOpen, setOpen, enqueue, cancel, cancelAll, hasActiveUploads }),
    [cancel, cancelAll, enqueue, hasActiveUploads, isOpen, tasks],
  )

  return <UploadQueueContext.Provider value={value}>{children}</UploadQueueContext.Provider>
}

export function useUploadQueue() {
  const ctx = useContext(UploadQueueContext)
  if (!ctx) throw new Error('useUploadQueue must be used within UploadQueueProvider')
  return ctx
}

function formatEta(seconds: number | null, fallback: string) {
  if (seconds == null || !Number.isFinite(seconds)) return fallback
  if (seconds < 1) return '<1s'
  const rounded = Math.ceil(seconds)
  if (rounded < 60) return `${rounded}s`
  const minutes = Math.floor(rounded / 60)
  const rest = rounded % 60
  return `${minutes}m ${String(rest).padStart(2, '0')}s`
}

function statusIcon(status: UploadTaskStatus) {
  if (status === 'completed') return <CheckCircle2 className="size-4 text-emerald-600" />
  if (status === 'failed') return <XCircle className="size-4 text-destructive" />
  if (status === 'cancelled') return <XCircle className="size-4 text-muted-foreground" />
  return <Loader2 className="size-4 animate-spin text-primary" />
}

function statusPillClass(status: UploadTaskStatus) {
  if (status === 'completed') return 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
  if (status === 'failed') return 'bg-destructive/10 text-destructive'
  if (status === 'cancelled') return 'bg-muted text-muted-foreground'
  return 'bg-primary/10 text-primary'
}

export function UploadStatusButton() {
  const { t } = useTranslation()
  const { tasks, isOpen, setOpen, cancel, cancelAll, hasActiveUploads } = useUploadQueue()

  const activeCount = tasks.filter((task) => isActive(task.status)).length
  const failedCount = tasks.filter((task) => task.status === 'failed').length
  const completedCount = tasks.filter((task) => task.status === 'completed').length

  return (
    <Popover open={isOpen} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon-sm" className="relative" aria-label={t('uploadPanel.toggle')}>
          <UploadCloud />
          {(activeCount > 0 || failedCount > 0) && (
            <Badge
              variant={failedCount > 0 ? 'destructive' : 'default'}
              className="-right-1.5 -top-1.5 absolute h-4 min-w-4 rounded-full px-1 text-[10px]"
            >
              {activeCount || failedCount}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        data-testid="upload-popover"
        className="flex max-h-[min(28rem,calc(100vh-4rem))] w-[min(calc(100vw-2rem),24rem)] flex-col overflow-hidden p-0"
      >
        <div className="flex shrink-0 items-center justify-between px-4 py-3">
          <div className="min-w-0">
            <h2 className="font-semibold text-sm">{t('uploadPanel.title')}</h2>
            <p className="text-muted-foreground text-xs">
              {t('uploadPanel.summary', { active: activeCount, completed: completedCount, total: tasks.length })}
            </p>
          </div>
          {hasActiveUploads && (
            <Button variant="ghost" size="sm" className="h-auto px-1 py-0 text-xs" onClick={cancelAll}>
              {t('uploadPanel.cancelAll')}
            </Button>
          )}
        </div>
        <Separator className="m-0" />
        {tasks.length === 0 ? (
          <div className="p-6 text-center text-muted-foreground text-sm">{t('uploadPanel.empty')}</div>
        ) : (
          <div
            data-testid="upload-task-list"
            className="max-h-[min(20rem,calc(100vh-9rem))] min-h-0 overflow-x-hidden overflow-y-auto"
          >
            {tasks.map((task) => {
              const pct = task.total > 0 ? Math.round((Math.min(task.loaded, task.total) / task.total) * 100) : 0
              const canCancel = isActive(task.status)
              return (
                <div
                  key={task.id}
                  className="min-w-0 overflow-hidden border-b px-4 py-3 transition-colors last:border-b-0 hover:bg-accent/50"
                >
                  <div className="flex items-start gap-3">
                    <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-muted">
                      {statusIcon(task.status)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 items-center gap-2 overflow-hidden">
                            <p className="min-w-0 flex-1 truncate font-medium text-sm">{task.fileName}</p>
                            <span
                              className={cn(
                                'shrink-0 rounded-full px-1.5 py-0.5 font-medium text-[10px]',
                                statusPillClass(task.status),
                              )}
                            >
                              {t(`uploadPanel.status.${task.status}`)}
                            </span>
                          </div>
                          <p className="mt-0.5 truncate text-muted-foreground text-xs">
                            {formatSize(Math.min(task.loaded, task.total))} / {formatSize(task.total)}
                            {task.speed > 0 ? ` · ${formatSize(task.speed)}/s` : ''}
                            {task.status !== 'completed' && task.status !== 'failed' && task.status !== 'cancelled'
                              ? ` · ${formatEta(task.etaSeconds, t('uploadPanel.etaUnknown'))}`
                              : ''}
                          </p>
                        </div>
                        {canCancel && (
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            onClick={() => cancel(task.id)}
                            aria-label={t('uploadPanel.cancel')}
                          >
                            <X />
                          </Button>
                        )}
                      </div>
                      <Progress value={pct} className="mt-2 h-1.5" />
                      {task.status === 'failed' && task.error && (
                        <p className="mt-1.5 line-clamp-2 text-destructive text-xs">{task.error}</p>
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
