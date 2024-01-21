import OBSWebSocket from 'obs-websocket-js'
import {ValorantAPI} from './ValorantAPI.js'
import {
    CoregameMatchData,
    LockfileData, MapDataResponse, PregameMatchData, PrivatePresence,
    ValorantChatSessionResponse,
    ValorantEvent,
    ValorantExternalSessionsResponse, ValorantMatchData,
    ValorantWebsocketEvent
} from './valorantTypes'
import {loadConfig} from './config.js'
import {WebSocket} from 'ws'
import {promises as fs} from 'node:fs'
import path from 'node:path'
import Mustache from 'mustache'
import fetch from 'node-fetch'

// @ts-ignore
Mustache.escape! = v => v

interface StopRecordResponse {
    outputPath: string
}

async function asyncTimeout(delay: number) {
    return new Promise((resolve, reject) => {
        setTimeout(resolve, delay)
    })
}

const matchCorePrefix = '/riot-messaging-service/v1/message/ares-core-game/core-game/v1/matches/'
const preGamePrefix = '/riot-messaging-service/v1/message/ares-pregame/pregame/v1/matches/'
const gameEndURI = '/riot-messaging-service/v1/message/ares-match-details/match-details/v1/matches'
const clientPlatform = 'ew0KCSJwbGF0Zm9ybVR5cGUiOiAiUEMiLA0KCSJwbGF0Zm9ybU9TIjogIldpbmRvd3MiLA0KCSJwbGF0Zm9ybU9TVmVyc2lvbiI6ICIxMC4wLjE5MDQyLjEuMjU2LjY0Yml0IiwNCgkicGxhdGZvcm1DaGlwc2V0IjogIlVua25vd24iDQp9'
const requestDelay = 5 * 1000

let gameVersion: string | null = null
let mapData: MapDataResponse | null = null

let gameID: string | null = null
let preGameID: string | null = null
let previousGameID: string | null = null
let dataDir: string | null = null
let websocketEvents: ValorantWebsocketEvent[] = []

async function loadPlayerData(val: ValorantAPI, dataDir: string, puuids: string[], ownPuuid: string, shard: string) {
    // Load game version if not already loaded
    if(gameVersion === null) {
        const presences = (await val.getPresences()).presences
        const ownPresence = presences.find(presence => presence.puuid === ownPuuid)
        if(ownPresence === undefined) {
            console.warn('Own presence data was not found')
        } else {
            const privateData = JSON.parse(Buffer.from(ownPresence.private, 'base64').toString('utf-8')) as PrivatePresence
            gameVersion = privateData.partyClientVersion
        }
    }

    // MMR and match history
    const mmrPath = path.join(dataDir, 'mmr')
    await fs.mkdir(mmrPath)
    const matchHistoryPath = path.join(dataDir, 'history')
    await fs.mkdir(matchHistoryPath)

    for(const puuid of puuids) {
        console.log(`Getting mmr and match history data ${puuid}`)
        await asyncTimeout(requestDelay)
        const mmrData = await val.requestRemotePD(`mmr/v1/players/${puuid}`, shard, {
            'X-Riot-ClientPlatform': clientPlatform,
            'X-Riot-ClientVersion': gameVersion
        })
        await fs.writeFile(path.join(mmrPath, `${puuid}.json`), JSON.stringify(mmrData), 'utf-8')

        await asyncTimeout(requestDelay)
        const matchHistoryData = await val.requestRemotePD(`match-history/v1/history/${puuid}?endIndex=25`, shard)
        await fs.writeFile(path.join(matchHistoryPath, `${puuid}.json`), JSON.stringify(matchHistoryData), 'utf-8')
    }
}

async function main() {
    const config = await loadConfig()

    // Try connecting to OBS
    const obs = new OBSWebSocket()
    if(config.obs.enable) {
        try {
            await obs.connect(`ws://${config.obs.ip}:${config.obs.port}`, config.obs.password)
        } catch(e) {
            console.error('Failed to connect to OBS')
            throw e
        }
    }

    // Set up Valorant API
    const val = new ValorantAPI()
    val.on('ready', async (lockfileData: LockfileData,
                           chatSession: ValorantChatSessionResponse,
                           externalSessions: ValorantExternalSessionsResponse) => {
        console.log('Waiting for game readiness...')
        const initData = await val.waitForInit(true)
        console.log('Game ready!')

        const help = await val.getHelp()
        console.log(`Loaded ${Object.keys(help.events).length} events, waiting for game...`)

        const ws = new WebSocket(`wss://riot:${lockfileData.password}@127.0.0.1:${lockfileData.port}`, {
            rejectUnauthorized: false
        });

        ws.on('close', () => {
            console.log('Disconnected from Valorant')
        })
        ws.on('open', () => {
            // Subscribe to all events by name
            const alwaysSubscribe = ['OnJsonApiEvent_chat_v4_presences', 'OnJsonApiEvent_riot-messaging-service_v1_message']
            Object.entries(help.events).forEach(([name, desc]) => {
                if(name === 'OnJsonApiEvent' || alwaysSubscribe.includes(name)) return;
                ws.send(JSON.stringify([5, name]));
            });
            for(const name of alwaysSubscribe) {
                ws.send(JSON.stringify([5, name]));
            }
        })
        ws.on('message', async message => {
            let event: string, data: ValorantEvent
            try {
                [, event, data] = JSON.parse(message.toString());
            } catch(e) {
                return;
            }

            if(event === 'OnJsonApiEvent_riot-messaging-service_v1_message') {
                if(data.uri === gameEndURI) {
                    if(gameID === null) {
                        console.warn('Game ended with null ID')
                    } else {
                        // Game end
                        console.log(`Game ${gameID} ended!`)

                        let outputPath: string | null = null
                        if(config.obs.enable) {
                            const response = (await obs.call('StopRecord')) as unknown as StopRecordResponse
                            outputPath = response.outputPath
                        }

                        await asyncTimeout(requestDelay)
                        console.log('Getting match data')
                        const matchData = await val.requestRemotePD<ValorantMatchData>(`match-details/v1/matches/${gameID}`, initData.shard)

                        // Rename output file with match data
                        if(outputPath !== null) {
                            if(mapData === null) {
                                mapData = (await (await fetch('https://valorant-api.com/v1/maps')).json()) as MapDataResponse
                            }
                            let score = ''
                            const ownPlayer = matchData.players.find(player => player.subject === chatSession.puuid)
                            if(ownPlayer !== undefined && matchData.teams !== null) {
                                const ownScore = matchData.teams.find(team => team.teamId === ownPlayer.teamId)!.numPoints

                                if(matchData.teams.length === 1) {
                                    score = ownScore.toString()
                                } else {
                                    const maxScore = matchData.teams.filter(team => team.teamId !== ownPlayer.teamId)
                                        .sort((t1, t2) => t2.numPoints - t1.numPoints)[0].numPoints
                                    score = `${ownScore}-${maxScore}`
                                }
                            }

                            const extension = path.extname(outputPath)
                            const newPath = Mustache.render(config.obs.renameTemplate, {
                                directory: path.dirname(outputPath),
                                extension,
                                'original-name': path.basename(outputPath, extension),
                                map: mapData.data.find(map => map.mapUrl === matchData.matchInfo.mapId)?.displayName || '',
                                queue: matchData.matchInfo.queueID,
                                score
                            })
                            console.log(`Renaming ${outputPath} to ${newPath}`)
                            await fs.rename(outputPath, newPath)
                        }

                        if(config.data.enable && dataDir !== null) {
                            await fs.writeFile(path.join(dataDir, 'events.json'), JSON.stringify(websocketEvents), 'utf-8')
                            await fs.writeFile(path.join(dataDir, 'match.json'), JSON.stringify(matchData), 'utf-8')
                        }
                    }
                    previousGameID = gameID
                    gameID = null
                    preGameID = null
                    dataDir = null
                } else if(data.uri.startsWith(matchCorePrefix)) {
                    if(gameID === null) {
                        const id = data.uri.substring(matchCorePrefix.length);
                        // Another core game ID can be sent after the "match details" message
                        // This check ensures  it's not interpreted as a game start
                        if(id !== previousGameID) {
                            gameID = id

                            // Game start
                            console.log(`Game ${gameID} started!`)

                            if(preGameID === null && config.obs.enable) {
                                await obs.call('StartRecord')
                            }

                            if(config.data.enable) {
                                // Reset websocket events log if there was no pregame to reset it
                                if(preGameID === null) {
                                    websocketEvents = []
                                }

                                if(dataDir === null) {
                                    dataDir = path.join(config.data.path, gameID)
                                    await fs.mkdir(dataDir, {recursive: true})
                                }
                                await asyncTimeout(15 * 1000)
                                console.log('Getting coregame and loadout data')
                                const coreGameData = await val.requestRemoteGLZ<CoregameMatchData>(`core-game/v1/matches/${gameID}`, initData.region, initData.shard)
                                await fs.writeFile(path.join(dataDir, 'coregame-match.json'), JSON.stringify(coreGameData), 'utf-8')
                                await asyncTimeout(requestDelay)
                                const loadoutsData = await val.requestRemoteGLZ(`core-game/v1/matches/${gameID}/loadouts`, initData.region, initData.shard)
                                await fs.writeFile(path.join(dataDir, 'loadouts.json'), JSON.stringify(loadoutsData), 'utf-8')

                                const puuids = coreGameData.Players.map(player => player.Subject)
                                await loadPlayerData(val, dataDir, puuids, chatSession.puuid, initData.shard)
                            }
                        }
                    }
                } else if(data.uri.startsWith(preGamePrefix)) {
                    if(preGameID === null) {
                        preGameID = data.uri.substring(preGamePrefix.length);

                        // Pre-game start
                        console.log(`Pregame ${preGameID} started!`)
                        websocketEvents = []

                        // Start OBS recording
                        if(config.obs.enable) {
                            await obs.call('StartRecord')
                        }

                        if(config.data.enable) {
                            dataDir = path.join(config.data.path, preGameID)
                            await fs.mkdir(dataDir, {recursive: true})

                            // Get pre-game match data
                            console.log('Getting pregame data')
                            const pregameMatchData: PregameMatchData = await val.requestRemoteGLZ(`pregame/v1/matches/${preGameID}`, initData.region, initData.shard)
                            await fs.writeFile(path.join(dataDir, 'pregame-match.json'), JSON.stringify(pregameMatchData), 'utf-8')
                        }
                    }
                }
            }

            // Save to websocket log
            if((preGameID !== null || gameID !== null) && config.data.enable) {
                websocketEvents.push({event, data})
            }
        })
    })
    try {
        await val.checkLockfile()
    } catch(ignored) {
        console.log('Waiting for Valorant to start...')
    }
}

(async () => {
    await main()
})()

