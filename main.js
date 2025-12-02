const BASE_URL = "http://10.101.0.1:10101/"
const TOKEN_URL = BASE_URL + "?token=renew"
const TASK_URL = BASE_URL + "task"
const CSV_URL = BASE_URL + "csv"

// ideally this sort of stuff goes in environment variables not the code
const tokenAuthFile = "./userpass.txt"
let tokenUser = ""
let tokenPass = ""

// get the Basic auth details from the userpass file in the same dir
// fetch is async
async function loadTokenAuth() {
    const f = await fetch(tokenAuthFile)
    const text = await f.text()
    const lines = text.split("\n")
    tokenUser = lines[0].trim()
    tokenPass = lines[1].trim()
}
await loadTokenAuth()

const TOKEN_BLANK = {
    value: "",
    created: 0,
    expires: 0
}

let token = TOKEN_BLANK
let isTaskStarted = false

const nodeData = []
const nodeReceivedCount = {}

const statusText = document.getElementById("status")
const csvMatchText = document.getElementById("csvMatch")
const csvGeneratedArea = document.getElementById("csvGenerated")
const csvFetchedArea = document.getElementById("csvFetched")

async function fetchToken() {
    try {
        // https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch
        const authString = btoa(tokenUser + ":" + tokenPass)

        const response = await fetch(TOKEN_URL, {
            method: "GET",
            headers: {
                "Authorization": "Basic " + authString,
            }
        })

        // https://developer.mozilla.org/en-US/docs/Web/XML/Guides/Parsing_and_serializing_XML
        const tokenXml = new DOMParser().parseFromString(await response.text(), "application/xml")

        let result = TOKEN_BLANK

        if (tokenXml.querySelector("errorNode")) {
            throw new Error("Cant parse token: " + tokenXml.querySelector("errorNode"))
        } else {
            result.value = tokenXml.querySelector("Value").textContent
            // force parse to interpret the given date as UTC, a little hacky but it works
            // https://stackoverflow.com/questions/32252565/javascript-parse-utc-date
            result.created = Date.parse(tokenXml.querySelector("Created").textContent + "Z")
            result.expires = Date.parse(tokenXml.querySelector("Expires").textContent + "Z")
            console.debug("Successfully fetched token: ")
            console.debug(result)
            return result
        }
    } catch (e) {
        console.error(e.message)
        return TOKEN_BLANK
    }
}

// https://stackoverflow.com/questions/951021/what-is-the-javascript-version-of-sleep
async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

async function postTo(endpoint, body) {
    const earlyRenewTime = 1000*60
    const renewRetryTimeout = 1000

    // renews token a minute early just to be sure since there is no real renewal limit
    // this might spam the server with requests if the fetch fails so some sort of timeout is nice
    while ((Date.now() + earlyRenewTime) >= token.expires) {
        token = await fetchToken()
        await sleep(renewRetryTimeout)
    }

    console.debug(`POST ${endpoint} ${body}`)

    return fetch(endpoint, {
        method: "POST",
        headers: {
            "Authorization": "Bearer " + token.value
        },
        body: body
    })
}

async function startTask() {
    const response = await postTo(TASK_URL,"command=begin")

    if (!response.ok) {
        console.error("Failed to start task: " + response.status)
    } else {
        console.log("Successfully started task: " + response.status)
        isTaskStarted = true
        statusText.innerText = "task started"
    }
}

async function endTask() {
    if (!isTaskStarted) {return}

    const response = await postTo(TASK_URL, "command=end")

    if (!response.ok) {
        console.error("Failed to end task: " + response.status)
    } else {
        console.log("Successfully ended task: " + response.status)
        isTaskStarted = false
        statusText.innerText = "task finished"
    }
}

async function getTaskValue(reqTime) {
    if (!isTaskStarted) {return}

    const response = await postTo(TASK_URL, "command=getvalue,request=" + reqTime)

    return await response.json()
}

function isWasherDataValid(data) {
    // has top level data key
    if (!("data" in data)) {
        console.debug("Missing data key")
        return false
    }

    data = data["data"]

    // has the node, type, name, temp keys
    const keys = ["node","type","name","temp"]
    for (const key of keys) {
        if (!(key in data)) {
            console.debug("Missing key: " + key)
            return false
        }
    }

    // type should not be "unknown"
    if (data["type"] === "unknown") {
        console.debug("Type is unknown")
        return false
    }

    // temp should be between [0;200)
    if (data["temp"] < 0 || data["temp"] >= 200) {
        console.debug("Temp is invalid")
        return false
    }

    return true
}

async function gatherWasherData(uptoCount = 100) {
    if (!isTaskStarted) {return}
    let keepGathering = true
    const readingTimeout = 1000

    while (keepGathering) {
        const now = new Date()
        const hours = now.getUTCHours() >= 10 ? now.getUTCHours() : "0" + now.getUTCHours()
        const minutes = now.getUTCMinutes() >= 10 ? now.getUTCMinutes() : "0" + now.getUTCMinutes()
        const seconds = now.getUTCSeconds() >= 10 ? now.getUTCSeconds() : "0" + now.getUTCSeconds()
        const reqTime = hours + ":" + minutes + ":" + seconds

        const reqData = await getTaskValue(reqTime)
        // save the request time for later
        reqData["time"] = reqTime

        console.debug(reqData)

        // verify that the data fits the listed criteria
        if (isWasherDataValid(reqData)) {

            // save the data for the node
            const node = reqData["data"]["node"]
            nodeData.push(reqData)

            // keep track of the received readings of each node
            if (node in nodeReceivedCount) {
                nodeReceivedCount[node]++
                if (nodeReceivedCount[node] >= uptoCount) {
                    console.log("Got " + uptoCount + " readings of node " + node + ", stopping")
                    keepGathering = false
                }
            } else {
                nodeReceivedCount[node] = 1
            }


        } else {
            console.debug("Got invalid data")
        }

        await sleep(readingTimeout)
    }

    console.debug(nodeData)
}

function washerDataToCsv(data) {
    let csv = "Time,Node,Type,Temperature°C,Δ\r\n"
    const lastReadingTemps = {}

    for (const reading of data) {
        // https://www.calculatorsoup.com/calculators/conversions/fahrenheit-to-celsius.php
        const time = reading["time"]
        const node = reading["data"]["node"]
        const type = reading["data"]["type"]
        const tempCelsius = Math.round(((reading["data"]["temp"] - 32) / 1.8) * 100) / 100

        csv += `${time},${node},${type},${tempCelsius},`

        // only include delta if there is a previous reading of the same node
        if (node in lastReadingTemps) {
            // rounded to 2 decimal places
            const delta = Math.round((tempCelsius - lastReadingTemps[node]) * 100) / 100
            csv += `${delta}`
        }

        // DOS carriage return
        csv += `\r\n`
        lastReadingTemps[node] = tempCelsius
    }

    console.debug("Generated CSV:")
    console.debug(csv)

    return csv
}

async function fetchVerificationCsv() {
    const response = await fetch(CSV_URL, {
        method: "GET",
        headers: {
            "Authorization": "Bearer " + token.value
        }
    })

    const csv = await response.text()

    console.debug("Received verification CSV:")
    console.debug(csv)

    return csv
}

await startTask()
await gatherWasherData(100)
await endTask()

csvGeneratedArea.value = washerDataToCsv(nodeData)
csvFetchedArea.value = await fetchVerificationCsv()

if (csvGeneratedArea.value === csvFetchedArea.value) {
    csvMatchText.textContent = "CSV data matches"
} else {
    csvMatchText.textContent = "CSV data does not match"
}