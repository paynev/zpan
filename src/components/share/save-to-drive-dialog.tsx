import { DirType } from '@shared/constants'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ApiError, listObjectsByPath, saveShareToDrive } from '@/lib/api'

interface SaveToDriveDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  token: string
  onPasswordRequired: () => void
}

// Radix Select forbids empty-string values, so use a sentinel to represent
// "root folder" in the UI and convert to '' in the request payload.
const ROOT_PATH_SENTINEL = '__root__'

export function SaveToDriveDialog({ open, onOpenChange, token, onPasswordRequired }: SaveToDriveDialogProps) {
  const { t } = useTranslation()
  const [selectedPath, setSelectedPath] = useState(ROOT_PATH_SENTINEL)
  const [pending, setPending] = useState(false)

  const foldersQuery = useQuery({
    queryKey: ['folders-for-save'],
    queryFn: () => listObjectsByPath('', undefined, 100, { type: 'folder' }),
    enabled: open,
  })

  const folders = (foldersQuery.data?.items ?? []).filter((item) => item.dirtype !== DirType.FILE)

  async function handleSave() {
    setPending(true)
    try {
      const result = await saveShareToDrive(token, {
        targetParent: selectedPath === ROOT_PATH_SENTINEL ? '' : selectedPath,
      })
      toast.success(t('share.saveSuccess', { count: result.saved.length }))
      onOpenChange(false)
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 400 && err.reason === 'QUOTA_EXCEEDED') {
          toast.error(t('share.quotaExceeded'))
        } else if (err.status === 401) {
          toast.error(t('share.passwordRequired'))
          onOpenChange(false)
          onPasswordRequired()
        } else if (err.status === 410) {
          toast.error(t('share.shareUnavailable'))
          onOpenChange(false)
        } else {
          toast.error(t('share.saveError'))
        }
      } else {
        toast.error(t('share.saveError'))
      }
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('share.saveToDriveTitle')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1">
            <Label>{t('share.folderLabel')}</Label>
            <Select value={selectedPath} onValueChange={setSelectedPath}>
              <SelectTrigger>
                <SelectValue placeholder={t('share.folderPlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ROOT_PATH_SENTINEL}>{t('share.folderRoot')}</SelectItem>
                {folders.map((folder) => {
                  const fullPath = folder.parent ? `${folder.parent}/${folder.name}` : folder.name
                  return (
                    <SelectItem key={folder.id} value={fullPath}>
                      {fullPath}
                    </SelectItem>
                  )
                })}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleSave} disabled={pending}>
            {t('share.saveButton')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
