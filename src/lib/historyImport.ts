import type { HistoryFile } from '../types'

export async function readHistoryFile(file: File) {
  const payload = JSON.parse(await file.text()) as HistoryFile

  if (!payload.categories?.length || !payload.records?.length) {
    throw new Error('This file does not contain WorthDelta history data.')
  }
  return payload
}
