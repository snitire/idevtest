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
            console.log("Successfully fetched token: ")
            console.log(result)
            return result
        }
    } catch (e) {
        console.error(e.message)
        return TOKEN_BLANK
    }
}

let token = TOKEN_BLANK

// https://stackoverflow.com/questions/951021/what-is-the-javascript-version-of-sleep
async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

async function postToTask(body) {
    // renews token a minute early just to be sure since there is no real renewal limit
    // this might spam the server with requests if the fetch fails so some sort of timeout is nice
    while ((Date.now() + 1000*60) >= token.expires) {
        token = await fetchToken()
        await sleep(1000)
    }

    return fetch(TASK_URL, {
        method: "POST",
        headers: {
            "Authorization": "Bearer " + token.value
        },
        body: body
    })
}

async function startTask() {
    const response = await postToTask("command=begin")

    if (!response.ok) {
        console.error("Failed to start task: " + response.status)
    } else {
        console.log("Successfully started task: " + response.status)
    }
}

async function endTask() {
    const response = await postToTask("command=end")

    if (!response.ok) {
        console.error("Failed to end task: " + response.status)
    } else {
        console.log("Successfully ended task: " + response.status)
    }
}

await startTask()
await endTask()