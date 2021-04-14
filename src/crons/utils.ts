import { ObjectId } from 'mongodb';
import { SkynetClient } from 'skynet-js';
import { EntryType, IContent } from '../database/types';
import { IPage, IRawEntry } from './types';

export async function downloadNewEntries(
  type: EntryType,
  client: SkynetClient,
  user: string,
  skapp: string,
  path: string,
  offset: number = 0
): Promise<IContent[]> {
  const page = await downloadFile<IPage<IRawEntry>>(client, user, path)
  return page.entries.slice(offset).map(el => {
    return {
      _id: new ObjectId(),
      type,
      user,
      skapp,
      skylink: el.content,
      metadata: el.metadata,
      createdAt: new Date(el.timestamp),
      scrapedAt: new Date(),
    }
  })
}

export async function downloadFile<T>(
  client: SkynetClient,
  user: string,
  path: string,
): Promise<T> {
  console.log('getting data', user, path)
  const response = await client.file.getJSON(user, path)
  if (!response || !response.data) {
    console.log(response)
    throw new Error(`Could not find file for user '${user}' at path '${path}'`)
  }
  console.log('found data', path, response.data)
  return response.data as unknown as T;
}
