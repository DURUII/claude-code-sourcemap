/**
 * Restoration placeholder for file-persistence shared types.
 *
 * The restored tree kept the orchestrator/scanner implementation but missed
 * this small shared module. The runtime constants are only used when remote
 * BYOC file persistence is enabled; normal local CLI execution never enters
 * that path.
 */

export type TurnStartTime = number

export type PersistedFile = {
  filename: string
  file_id: string
}

export type FailedPersistence = {
  filename: string
  error: string
}

export type FilesPersistedEventData = {
  files: PersistedFile[]
  failed: FailedPersistence[]
}

export const OUTPUTS_SUBDIR = 'outputs'
export const FILE_COUNT_LIMIT = 1000
export const DEFAULT_UPLOAD_CONCURRENCY = 4
