import { z } from '@hono/zod-openapi'
import { opaqueIdSchema, shareTokenSchema } from './id'

const n = z.number()
const ni = z.number().int()
const nn = n.nullable()
const dated = z.object({ date: z.string() })
const delta = z.object({ value: nn, previousValue: nn, change: nn, changePercent: nn })
const coverage = z.object({
  status: z.enum(['complete', 'partial', 'empty']),
  expectedBuckets: ni,
  completedBuckets: ni,
  lowerBoundBuckets: ni,
  quality: z.enum(['exact', 'lower_bound']),
  dataThrough: z.string().nullable(),
})
const range = {
  generatedAt: z.string(),
  from: z.string(),
  to: z.string(),
  timeZone: z.literal('UTC'),
  coverage,
  comparisonCoverage: coverage.optional(),
  snapshotCoverage: coverage.optional(),
  comparisonSnapshotCoverage: coverage.optional(),
}
const transferQuality = z.object({
  missingUploadBytesEvents: ni,
  previousMissingUploadBytesEvents: ni,
  missingDownloadBytesEvents: ni,
  previousMissingDownloadBytesEvents: ni,
  missingBytesEvents: ni,
  previousMissingBytesEvents: ni,
})
const nameValuePercent = z.object({ name: z.string(), value: n, percent: n })

export const adminAnalyticsOverviewSchema = z
  .object({
    ...range,
    dataQuality: transferQuality,
    totals: z.object({
      users: nn,
      newUsers: delta,
      activeUsers: delta,
      activeUserRate: nn,
      storageUsedBytes: nn,
      storageQuotaBytes: nn,
      storageUtilization: nn,
      trafficBytes: delta,
      uploadBytes: delta,
      downloadBytes: delta,
      activeShares: nn,
      shareDownloads: delta,
    }),
    trends: z.array(
      dated.extend({
        newUsers: nn,
        activeUsers: nn,
        storageUsedBytes: nn,
        uploadBytes: nn,
        downloadBytes: nn,
      }),
    ),
  })
  .openapi('AdminAnalyticsOverview')

export const adminAnalyticsGrowthSchema = z
  .object({
    ...range,
    summary: z.object({
      totalUsers: nn,
      newUsers: delta,
      activeUsers: delta,
      verifiedUsers: nn,
      bannedUsers: nn,
      silentUsers: nn,
      activeUserRate: nn,
      silentUserRate: nn,
    }),
    userScaleTrend: z.array(dated.extend({ newUsers: nn, totalUsers: nn })),
    activeUserTrend: z.array(dated.extend({ dau: nn, wau: nn, mau: nn })),
    userStatus: z.array(nameValuePercent),
    registrationSources: z.array(nameValuePercent),
  })
  .openapi('AdminAnalyticsGrowth')

export const adminAnalyticsStorageSchema = z
  .object({
    ...range,
    dataQuality: transferQuality.extend({
      usageDriftSpaces: nn,
      usageDriftBytes: nn,
      ledgerDriftSpaces: nn,
      ledgerDriftBytes: nn,
    }),
    summary: z.object({
      storageUsedBytes: nn,
      quotaBytes: nn,
      fileCount: nn,
      trashFileCount: nn,
      trashBytes: nn,
      newFiles: delta,
      newBytes: delta,
      coldFileBytes: nn,
      storageUtilization: nn,
      coldFilePercent: nn,
      nearQuotaSpaces: nn,
      overQuotaSpaces: nn,
      invalidQuotaSpaces: nn,
    }),
    storageTrend: z.array(dated.extend({ usedBytes: nn, newBytes: nn, newFiles: nn })),
    typeBreakdown: z.array(z.object({ type: z.string(), bytes: n, files: n, percent: n })),
    sizeBreakdown: z.array(z.object({ name: z.string(), bytes: n, files: n, percent: n })),
    ageBreakdown: z.array(z.object({ name: z.string(), bytes: n, files: n, percent: n })),
  })
  .openapi('AdminAnalyticsStorage')

export const adminAnalyticsTrafficSchema = z
  .object({
    ...range,
    dataQuality: transferQuality,
    summary: z.object({
      totalBytes: delta,
      requestCount: delta,
      issuedDownloads: nn,
      blockedDownloads: nn,
      downloadIssueSuccessRate: nn,
      peakDailyBytes: nn,
    }),
    trafficTrend: z.array(dated.extend({ uploadBytes: nn, downloadBytes: nn, requests: nn })),
    sourceBreakdown: z.array(z.object({ name: z.string(), bytes: n, requests: n, percent: n })),
    issueStatus: z.array(z.object({ status: z.string(), count: n, percent: n })),
    successTrend: z.array(dated.extend({ uploadSuccessRate: nn, downloadSuccessRate: nn })),
    failureReasons: z.array(nameValuePercent),
  })
  .openapi('AdminAnalyticsTraffic')

export const adminAnalyticsSharingSchema = z
  .object({
    ...range,
    dataQuality: z.object({ unlocatedDownloads: nn }),
    summary: z.object({
      activeShares: nn,
      createdShares: delta,
      views: nn,
      downloads: delta,
      saves: delta,
    }),
    trend: z.array(dated.extend({ downloads: nn, saves: nn })),
    typeBreakdown: z.array(nameValuePercent),
    sourceBreakdown: z.array(nameValuePercent),
    topShares: z.array(
      z.object({
        id: opaqueIdSchema,
        token: shareTokenSchema,
        name: z.string(),
        creatorId: opaqueIdSchema,
        creatorName: z.string(),
        views: n,
        downloads: n,
        status: z.string(),
        viewPercent: n,
        downloadPercent: n,
      }),
    ),
  })
  .openapi('AdminAnalyticsSharing')

export const adminAnalyticsOperationsSchema = z
  .object({
    ...range,
    summary: z.object({
      activeBackgroundJobs: nn,
      activeRemoteDownloads: nn,
      onlineDownloaders: nn,
      offlineDownloaders: nn,
      backgroundJobFailureRate: nn,
      remoteDownloadSuccessRate: nn,
      cloudReportBacklog: nn,
      cloudReportDeadLetters: nn,
      webhookFailures: nn,
      alertCount: nn,
    }),
    trend: z.array(
      dated.extend({
        completedJobs: n,
        failedJobs: n,
        completedRemoteDownloads: n,
        failedRemoteDownloads: n,
      }),
    ),
    backgroundJobOutcomes: z.array(nameValuePercent),
    remoteDownloadOutcomes: z.array(nameValuePercent),
    downloaderStatus: z.array(nameValuePercent),
    cloudReportStatus: z.array(nameValuePercent),
  })
  .openapi('AdminAnalyticsOperations')
