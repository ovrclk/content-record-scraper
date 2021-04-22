import { Collection } from 'mongodb';
import { SignedRegistryEntry, SkynetClient } from 'skynet-js';
import { SKYFEED_SEED_USER_PUBKEY, SKYNET_PORTAL_URL } from '../consts';
import { COLL_EVENTS, COLL_USERS } from '../database';
import { MongoDB } from '../database/mongodb';
import { EventType, IEvent, IUser } from '../database/types';
import { upsertUser } from '../database/utils';
import { IDictionary, IUserProfile, Throttle } from './types';
import { settlePromises } from './utils';

const DATAKEY_PROFILE = "profile"
const DATAKEY_FOLLOWING = "skyfeed-following"
const DATAKEY_FOLLOWERS = "skyfeed-followers"

// fetchSkyFeedUsers is a simple scraping algorithm that scrapes all known users
// from skyfeed.
export async function fetchSkyFeedUsers(throttle: Throttle<number>): Promise<number> {
  // create a client
  const client = new SkynetClient(SKYNET_PORTAL_URL);
  
  // create a connection with the database and fetch the users DB
  const db = await MongoDB.Connection();
  const userDB = await db.getCollection<IUser>(COLL_USERS);
  const eventsDB = await db.getCollection<IEvent>(COLL_EVENTS);

  // ensure the seed user is in our database
  const inserted = await upsertUser(userDB, SKYFEED_SEED_USER_PUBKEY)
  if (inserted) {
    console.log(`${new Date().toLocaleString()}: Skyfeed seed user '${SKYFEED_SEED_USER_PUBKEY}' inserted.`)
  }

  // fetch all known user pubkeys
  const usersResult = await userDB.aggregate<{users: string[]}>([
    {
      $group:
      {
        _id: null,
        users: { $addToSet: '$userPK' }
      }
    }
  ]).toArray()

  // extract into an array
  let users: string[] = []
  if (usersResult.length && usersResult[0].users) {
    users = usersResult[0].users
  }

  // turn into a user map
  const userMap = {};
  for (const userPK of users) {
    userMap[userPK] = true;
  }

  // loop every user fetch his followers and following
  const promises = [];
  for (const userPK of users) {
    const promise = throttle(fetchUsers.bind(
      null,
      client,
      userDB,
      userMap,
      userPK
    ))()

    // catch unhandled promise rejections but don't handle the error, we'll
    // process the error when all promises were settled
    //
    // tslint:disable-next-line: no-empty
    promise.catch(() => {})
    promises.push(promise)
  }

  // wait for all promises to be settled
  return await settlePromises(
    eventsDB,
    EventType.FETCHSKYFEEDUSERS_ERROR,
    promises,
    'fetchSkyFeedUsers' // context for console.log
  )
}

async function fetchUsers(
  client: SkynetClient,
  userDB: Collection<IUser>,
  userMap: IDictionary<object>,
  userPK: string,
): Promise<number> {
  // fetch user profile
  const profile = await fetchUserProfile(client, userPK)

  // sanity check skyfeed is listed in the user's dapps
  if (!profile.dapps.skyfeed) {
    throw new Error(`Skyfeed not in profile for user '${userPK}'`)
  }

  // fetch users' followers and following
  const publicKey = profile.dapps.skyfeed.publicKey;
  const following = await client.db.getJSON(publicKey, DATAKEY_FOLLOWING)
  const followers = await client.db.getJSON(publicKey, DATAKEY_FOLLOWERS)
  const relationsMap = { ...following.data, ...followers.data }
  const relations = Object.keys(relationsMap).map(String);

  // find out which users are new
  const discovered = [];
  for (const user of relations) {
    if (!userMap[user]) {
      discovered.push(user)
    }
  }

  // upsert the new users
  let total = 0;
  for (const user of discovered) {
    if (await upsertUser(userDB, user)) {
      total++;
    }
  }

  return total;
}

async function fetchUserProfile(
  client: SkynetClient,
  userPK: string,
): Promise<IUserProfile> {
  // fetch user's profile skylink
  const response: SignedRegistryEntry = await client.registry.getEntry(userPK, DATAKEY_PROFILE)
  if (!response || !response.entry) {
    throw new Error(`Could not find profile for user '${userPK}'`)
  }

  // fetch user's profile data
  let profileDataStr: string
  try {
    const content = await client.getFileContent<string>(response.entry.data)
    profileDataStr = content.data
  } catch (error) {
    throw new Error(`Profile was not found for user '${userPK}', err ${error.message}`)
  }

  // try to parse it as JSON
  let profile: IUserProfile
  try {
    profile = JSON.parse(profileDataStr)
  } catch (error) {
    throw new Error(`Profile was not valid JSON for user '${userPK}'`)
  }

  return profile;
}