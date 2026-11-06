import MDEditor from '@uiw/react-md-editor'
import '@uiw/react-md-editor/markdown-editor.css'
import '@uiw/react-markdown-preview/markdown.css'
import { useTheme } from 'next-themes'

interface AnnouncementMarkdownEditorProps {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
}

export function AnnouncementMarkdownEditor({ id, label, value, onChange }: AnnouncementMarkdownEditorProps) {
  const { resolvedTheme } = useTheme()

  return (
    <div data-color-mode={resolvedTheme === 'dark' ? 'dark' : 'light'}>
      <MDEditor
        className="overflow-hidden rounded-md border"
        height={360}
        minHeight={240}
        maxHeight={720}
        preview="live"
        textareaProps={{
          id,
          'aria-label': label,
        }}
        value={value}
        visibleDragbar
        onChange={(nextValue) => onChange(nextValue ?? '')}
      />
    </div>
  )
}
