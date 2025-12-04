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
const READINGS_REQUIRED = 100
const TEMP_MIN = 0
const TEMP_MAX = 200

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
    if (data["temp"] < TEMP_MIN || data["temp"] >= TEMP_MAX) {
        console.debug("Temp is invalid")
        return false
    }

    return true
}

async function gatherWasherData(uptoCount = READINGS_REQUIRED) {
    if (!isTaskStarted) {return}
    let keepGathering = true
    const readingTimeout = 1000

    while (keepGathering) {
        // get current time in HH:mm:ss format, padding with 0 if required
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

// https://www.stefanjudis.com/snippets/how-trigger-file-downloads-with-javascript/
function downloadAsFile(data, filename, linkText) {
    const file = new File([data], filename)

    const link = document.createElement("a")
    link.download = filename
    link.href = URL.createObjectURL(file)

    const container = document.createElement("div")
    container.appendChild(link)
    document.body.appendChild(container)

    link.innerText = linkText
}

await startTask()
await gatherWasherData()
await endTask()

const generatedCsv = washerDataToCsv(nodeData)
const verificationCsv = await fetchVerificationCsv()
csvGeneratedArea.value = generatedCsv
csvFetchedArea.value = verificationCsv

if (generatedCsv === verificationCsv) {
    csvMatchText.textContent = "CSV data matches"
} else {
    csvMatchText.textContent = "CSV data does not match"
}

downloadAsFile(generatedCsv, "readingdata_generated.csv", "Download generated CSV")
downloadAsFile(verificationCsv, "readingdata_fetched.csv", "Download fetched CSV")

// find the node with the 100 readings and plot that
let targetNode
for (const node in nodeReceivedCount) {
    if (nodeReceivedCount[node] >= READINGS_REQUIRED) {
        targetNode = node
        break
    }
}
createTemperatureChart(targetNode)

// chart the temperature graph using Hermite Cubic interpolation with a factor of 10

// given the separate temperature data points, put them on a time and temperature axis grid and make a graph through
// every point. individual lines between points use hermite cubic interpolation
// factor of 10 = 10 lines between each real data point?
// 1. add 9 interpolated points, 2. draw straight lines between each point
// https://paulbourke.net/miscellaneous/interpolation/
// change mu in steps of 0.1 up to 0.9 = 9 interpolated points
// for first y1, since there is no y0, use y0 = y1
// same thing for the last point, but y4 = y3

function xy(x, y) {
    return {x: x, y: y}
}

function createTemperatureChart(node) {
    // https://www.w3schools.com/graphics/canvas_intro.asp

    const C_WIDTH = 2000
    const C_HEIGHT = 2000
    const MARGIN = 70

    const canvas = document.createElement("canvas")
    const ctx = canvas.getContext("2d")

    canvas.width = C_WIDTH
    canvas.height = C_HEIGHT
    canvas.style = "border:1px solid #000000;"

    // title, middle of the canvas a little from the top
    ctx.textBaseline = "middle"
    drawText(ctx,
        `Temperature of node ${node}, °F`,
        "24px sans-serif",
        xy(C_WIDTH / 2, 24)
    )

    // axes
    const Y_TOP = MARGIN
    const Y_BOTTOM = C_HEIGHT-MARGIN
    const X_LEFT = MARGIN
    const X_RIGHT = C_WIDTH-MARGIN
    const AXIS_WIDTH = 4
    // y [0;200)
    drawLine(ctx,
        xy(X_LEFT, Y_TOP),
        xy(X_LEFT, Y_BOTTOM),
        AXIS_WIDTH
    )
    // x depends on the times and reading count
    drawLine(ctx,
        xy(X_LEFT, Y_BOTTOM),
        xy(X_RIGHT, Y_BOTTOM),
        AXIS_WIDTH
    )

    // reusing reading data instead of parsing the csv
    const data = nodeData.filter(reading => reading["data"]["node"] == targetNode)
    console.debug(`Plotting temp data of node ${targetNode}:`)
    console.debug(data)

    // axis ticks and labels
    const LABEL_FONT = "10px sans-serif"
    const TICK_LENGTH = 10

    // y axis
    const Y_TICK_COUNT = 10
    const Y_ABS_TOTAL = Math.abs(TEMP_MAX) + Math.abs(TEMP_MIN)

    // one Y tick every 200/10 = 20 degrees
    const Y_TICK = Y_ABS_TOTAL / Y_TICK_COUNT
    const Y_TICK_SPACING_PX = (Y_BOTTOM - Y_TOP) / Y_TICK_COUNT

    for (let i = 0; i <= Y_TICK_COUNT; i++) {
        const tickXY = xy(X_LEFT, Y_BOTTOM - Y_TICK_SPACING_PX * i)

        // tick
        drawLine(ctx,
            xy(tickXY.x - TICK_LENGTH/2, tickXY.y),
            xy(tickXY.x + TICK_LENGTH/2, tickXY.y),
            AXIS_WIDTH
        )

        // label
        drawText(ctx,
            `${TEMP_MIN + Y_TICK * i}`,
            LABEL_FONT,
            xy(tickXY.x - TICK_LENGTH, tickXY.y),
            0,
            "right"
        )
    }

    // x axis
    const X_TICK_COUNT = data.length
    const X_TICK_SPACING_PX = (X_RIGHT - X_LEFT) / (X_TICK_COUNT + 1)

    // leave a 1 tick gap from the y axis
    for (let i = 1; i <= X_TICK_COUNT; i++) {
        const tickXY = xy(X_LEFT + X_TICK_SPACING_PX * i, Y_BOTTOM)

        // tick
        drawLine(ctx,
            xy(tickXY.x, tickXY.y - TICK_LENGTH/2),
            xy(tickXY.x, tickXY.y + TICK_LENGTH/2),
            AXIS_WIDTH
        )

        // label
        drawText(ctx,
            data[i-1]["time"],
            LABEL_FONT,
            xy(tickXY.x, tickXY.y + TICK_LENGTH),
            -70,
            "right"
        )
    }

    const dataPointXY = []

    // draw the base data points
    for (const [idx, reading] of data.entries()) {
        const temp = reading["data"]["temp"]
        // 0 to 1, where on the Y axis would the point be above the X axis
        const yRatio = 1-temp/Y_ABS_TOTAL
        const pointXY = xy(X_LEFT + X_TICK_SPACING_PX * (idx+1), Y_TOP + yRatio * (Y_BOTTOM - Y_TOP))

        drawPoint(ctx,
            pointXY
        )
        dataPointXY.push(pointXY)
    }

    // contains interpolated points after all but the last point in dataPointXY
    // also contains the main data points themselves to make drawing easier
    const interpolatedPointXY = []
    const FACTOR = 10

    // interpolate the additional points using Hermite Cubic interpolation with a factor of 10
    for (const [idx, point] of dataPointXY.entries()) {
        // do not interpolate past the last point
        if (idx === dataPointXY.length - 1) {
            interpolatedPointXY.push(point)
            break
        }

        let y1 = point.y
        let x1 = point.x
        let y2 = dataPointXY[idx+1].y
        let x2 = dataPointXY[idx+1].x
        let y0,y3

        interpolatedPointXY.push(point)

        // handle first and last-1 point separately
        if (idx === 0) {
            y0 = point.y
            y3 = dataPointXY[idx+2].y
        } else if (idx === dataPointXY.length - 2) {
            y0 = dataPointXY[idx-1].y
            y3 = point.y
        } else {
            // all other intermediate points
            y0 = dataPointXY[idx-1].y
            y3 = dataPointXY[idx+2].y
        }

        for (let j = 1; j < FACTOR; j++) {
            const mu = 1/FACTOR * j
            interpolatedPointXY.push(xy(
                x1 + mu * (x2-x1),
                hermiteInterpolate(y0,y1,y2,y3,mu)
            ))
        }
    }

    // connect the points
    for (let i = 0; i < interpolatedPointXY.length - 1; i++) {
        drawLine(ctx,
            interpolatedPointXY[i],
            interpolatedPointXY[i+1]
        )
    }

    // add to dom
    const container = document.createElement("div")
    container.appendChild(canvas)
    document.body.appendChild(container)
}

// start and end assume xy() is used
function drawLine(ctx, startXY, endXY, lineWidth = 1) {
    ctx.beginPath()
    ctx.moveTo(startXY.x, startXY.y)
    ctx.lineTo(endXY.x, endXY.y)
    ctx.lineWidth = lineWidth
    ctx.stroke()
}

function drawText(ctx, text, font, whereXY, angle = 0, align = "center") {
    // https://stackoverflow.com/questions/3167928/drawing-rotated-text-on-a-html5-canvas
    ctx.save();
    ctx.translate(whereXY.x, whereXY.y)
    ctx.rotate(angle * (Math.PI / 180));
    ctx.textAlign = align
    ctx.font = font
    ctx.fillText(text, 0, 0)
    ctx.restore();
}

function drawPoint(ctx, centerXY, diameter = 3) {
    ctx.beginPath()
    ctx.arc(centerXY.x,centerXY.y,diameter/2,0,2*Math.PI)
    ctx.fill()
    ctx.stroke()
}

// https://paulbourke.net/miscellaneous/interpolation/
// y0 - prev point before y1
// y1, y2 - the space between 2 data points
// y3 - next point after y2
// mu - 0 to 1, ratio determining where in the space between y1 and y2 the value is being interpolated
// "Tension can be used to tighten up the curvature at the known points. The bias is used to twist the curve about the known points."
// Result - new interpolated y value at mu
function hermiteInterpolate(y0,y1,y2,y3,mu,tension=0,bias=0) {
    let m0, m1, mu2, mu3;
    let a0, a1, a2, a3;

    mu2 = mu*mu
    mu3 = mu2*mu

    m0 =  (y1-y0)*(1+bias)*(1-tension)/2
    m0 += (y2-y1)*(1-bias)*(1-tension)/2
    m1 =  (y2-y1)*(1+bias)*(1-tension)/2
    m1 += (y3-y2)*(1-bias)*(1-tension)/2

    a0 =  2*mu3 - 3*mu2 + 1;
    a1 =    mu3 - 2*mu2 + mu;
    a2 =    mu3 -   mu2;
    a3 = -2*mu3 + 3*mu2;

    return (a0*y1+a1*m0+a2*m1+a3*y2)
}