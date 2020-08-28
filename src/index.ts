import axios, { AxiosResponse } from "axios";
import { createObjectCsvWriter } from "csv-writer";
import { compareTwoStrings } from "string-similarity";
import { chainFrom } from "transducist";
import { parseStringPromise } from "xml2js";
import bgaGameList from "./bgaGameList";

const BGG_BASE_URL = "https://www.boardgamegeek.com/xmlapi2";

async function main(): Promise<void> {
  const data = await Promise.all(bgaGameList.map(getGameData));
  const nonNullData = chainFrom(data).removeAbsent().toArray();
  await saveGameDataToCsv("out.csv", nonNullData);
}

interface GameData {
  bgaName: string;
  bggName: string;
  rank: number;
  rating: number;
  weight: number;
  minPlayers: number;
  maxPlayers: number;
  playingTime: number;
  bggLink: string;
}

async function getGameData(name: string): Promise<GameData | undefined> {
  const gameId = await getGameId(name);
  if (gameId == null) {
    return undefined;
  }
  let gameResponse;
  try {
    gameResponse = await withRetries(() =>
      axios.get<string>(BGG_BASE_URL + `/thing`, {
        params: { id: gameId, stats: 1 },
      }),
    );
  } catch (error) {
    console.error(`Failed to retrieve data: ${name} (id: ${gameId})`);
    throw error;
  }
  const gameInfo = await parseStringPromise(gameResponse.data);
  const item = gameInfo.items.item[0];
  const bggName = item.name[0]["$"].value;
  const ratings = item.statistics[0].ratings[0];
  const rankObject = ratings.ranks[0].rank[0]["$"];
  const rank = +rankObject.value;
  const rating = +rankObject.bayesaverage;
  const weight = +ratings.averageweight[0]["$"].value;
  const minPlayers = +item.minplayers[0]["$"].value;
  const maxPlayers = +item.maxplayers[0]["$"].value;
  const playingTime = +item.playingtime[0]["$"].value;
  return {
    bgaName: name,
    bggName,
    rank,
    rating,
    weight,
    minPlayers,
    maxPlayers,
    playingTime,
    bggLink: `https://boardgamegeek.com/boardgame/${gameId}`,
  };
}

/**
 * Looks up a BoardGameGeek game ID based on a game's name. If the name has
 * several matches, then as a heuristic choose the one whose name is closest via
 * a string similarity algorithm.
 */
async function getGameId(name: string): Promise<number | undefined> {
  let searchResponse;
  try {
    searchResponse = await withRetries(() =>
      axios.get<string>(BGG_BASE_URL + "/search", {
        params: { query: name, type: "boardgame" },
      }),
    );
  } catch (error) {
    console.error(`Failed on search: ${name}`);
    throw error;
  }
  const searchResults = await parseStringPromise(searchResponse.data);
  if (!searchResults.items?.item) {
    console.log(`Failed lookup: ${name}`);
    return undefined;
  }
  const result = chainFrom(searchResults.items.item as any[])
    .filter((item) => item.name[0]["$"].type === "primary")
    .map((item) => ({
      id: item["$"].id,
      name: item.name[0]["$"].value,
      similarity: compareTwoStrings(
        name.toLowerCase(),
        item.name[0]["$"].value.toLowerCase(),
      ),
    }))
    .max((item1, item2) => item1.similarity - item2.similarity);
  if (!result) {
    console.log(`Failed lookup (no match was primary): ${name}`);
    return undefined;
  }
  if (name !== result.name) {
    console.log(`Renamed ${name} -> ${result.name}`);
  }
  return result.id;
}

async function saveGameDataToCsv(
  filename: string,
  data: GameData[],
): Promise<void> {
  const csvWriter = createObjectCsvWriter({
    path: filename,
    header: [
      { id: "bgaName", title: "Name (Board Game Arena)" },
      { id: "bggName", title: "Name (BoardGameGeek)" },
      { id: "rank", title: "Rank" },
      { id: "rating", title: "Rating" },
      { id: "weight", title: "Weight" },
      { id: "playingTime", title: "Playing time (minutes)" },
      { id: "minPlayers", title: "Minimum players" },
      { id: "maxPlayers", title: "Maximum players" },
      { id: "bggLink", title: "Link (BoardGameGeek)" },
    ],
  });
  await csvWriter.writeRecords(data);
}

const INITIAL_WAIT = 1000;
const MAX_WAIT = 30000;

/**
 * Retries the provided fetch call with exponential backoff in order to dodge
 * rate limits.
 */
async function withRetries<T>(
  fetch: () => Promise<AxiosResponse<T>>,
): Promise<AxiosResponse<T>> {
  let nextWait = INITIAL_WAIT;
  while (true) {
    try {
      return await fetch();
    } catch (error) {
      // 429 response is rate-limited.
      if (error?.response?.status !== 429) {
        throw error;
      }
      await delay(nextWait);
      nextWait = Math.min(MAX_WAIT, 2 * nextWait);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main();
