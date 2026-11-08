import { DEFAULT_SITE_NAME } from '@shared/constants'
import { Link, useRouterState } from '@tanstack/react-router'
import { ChevronRight, FileText, FolderOpen, Image, Music, Share2, Trash2, Video } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useBranding } from '@/components/branding/BrandingProvider'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar'
import { useSiteConfig } from '@/hooks/use-site-config'
import { FolderTree } from './folder-tree'
import { UserAccountMenu } from './user-account-menu'

export function AppSidebar() {
  const { t } = useTranslation()
  const { data: siteConfig } = useSiteConfig()
  const siteName = siteConfig?.site.name ?? DEFAULT_SITE_NAME
  const { branding } = useBranding()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const fileType = useRouterState({ select: (s) => (s.location.search as { type?: string })?.type })
  const isFiles = pathname === '/files'
  const activeFilesNav = isFiles && !fileType
  const activeFileType = (type: string) => isFiles && fileType === type
  const activeRecycleBin = pathname === '/trash'
  const activeShares = pathname.startsWith('/shares')

  return (
    <Sidebar>
      <SidebarHeader className="gap-2 px-3 pt-3 pb-1">
        <div className="-mx-3 flex items-center gap-2.5 border-b px-4 pb-3">
          <img src={branding.logo_url ?? '/logo.png'} alt={siteName} className="size-8" />
          <span className="text-lg font-semibold">{siteName}</span>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup className="px-3">
          <SidebarGroupContent>
            <SidebarMenu>
              <Collapsible defaultOpen className="group/collapsible">
                <SidebarMenuItem>
                  <CollapsibleTrigger asChild>
                    <SidebarMenuButton asChild isActive={activeFilesNav}>
                      <Link to="/files">
                        <FolderOpen className="h-4 w-4" />
                        <span>{t('nav.files')}</span>
                        <ChevronRight className="ml-auto h-4 w-4 transition-transform group-data-[state=open]/collapsible:rotate-90" />
                      </Link>
                    </SidebarMenuButton>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <FolderTree />
                  </CollapsibleContent>
                </SidebarMenuItem>
              </Collapsible>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={activeFileType('photos')}>
                  <Link to="/files" search={{ type: 'photos' }}>
                    <Image className="h-4 w-4" />
                    <span>{t('nav.photos')}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={activeFileType('videos')}>
                  <Link to="/files" search={{ type: 'videos' }}>
                    <Video className="h-4 w-4" />
                    <span>{t('nav.videos')}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={activeFileType('music')}>
                  <Link to="/files" search={{ type: 'music' }}>
                    <Music className="h-4 w-4" />
                    <span>{t('nav.music')}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={activeFileType('documents')}>
                  <Link to="/files" search={{ type: 'documents' }}>
                    <FileText className="h-4 w-4" />
                    <span>{t('nav.documents')}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={activeShares}>
                  <Link to="/shares" search={{ status: 'all', box: 'sent' }}>
                    <Share2 className="h-4 w-4" />
                    <span>{t('nav.shares')}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={activeRecycleBin}>
                  <Link to="/trash">
                    <Trash2 className="h-4 w-4" />
                    <span>{t('nav.trash')}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      {!branding.hide_powered_by && (
        <div className="px-4 py-1 text-center text-[10px] text-muted-foreground/30">
          Powered by{' '}
          <a
            href="https://github.com/saltbo/zpan"
            target="_blank"
            rel="noopener noreferrer"
            className="no-underline hover:underline hover:text-muted-foreground/50 transition-colors"
          >
            ZPan
          </a>
        </div>
      )}
      <SidebarFooter className="border-t p-3">
        <SidebarMenu>
          <SidebarMenuItem>
            <div className="flex items-center gap-1">
              <UserAccountMenu showAdminLink showFrontendLinks />
            </div>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  )
}
