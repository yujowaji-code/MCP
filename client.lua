-- Relay client. Served by your server at /script, which fills in the address below.
-- Run once to save your token:  writefile("relay_token.txt", "YOUR_TOKEN")
-- Then start it with:  loadstring(game:HttpGet("https://YOUR_DOMAIN/script"))()
local BASE = "__BASE__"
local TOKEN_FILE = "relay_token.txt"

local RETRY_DELAY = 3

local HttpService = game:GetService("HttpService")
local env = (getgenv and getgenv()) or _G
local httpRequest = request or http_request

local TOKEN = env.RELAY_TOKEN
if not TOKEN and isfile and readfile and isfile(TOKEN_FILE) then
    TOKEN = readfile(TOKEN_FILE)
end
TOKEN = type(TOKEN) == "string" and TOKEN:gsub("%s+", "") or nil
if not TOKEN or TOKEN == "" then
    warn('[relay] no token. Run once: writefile("' .. TOKEN_FILE .. '", "YOUR_TOKEN")')
    return
end

if not httpRequest then
    warn("[relay] this executor has no request/http_request function")
    return
end
if not loadstring then
    warn("[relay] this executor has no loadstring function")
    return
end

-- A newer launch of this script replaces the loop of an older one.
local runId = tostring(os.clock()) .. tostring(math.random(1, 1e9))
env.__RELAY_RUN = runId
local function active() return env.__RELAY_RUN == runId end

local function encode(value)
    local ok, json = pcall(HttpService.JSONEncode, HttpService, value)
    return ok and json or nil
end

local function call(method, path, body)
    local request = {
        Url = BASE .. path,
        Method = method,
        Headers = { ["Authorization"] = "Bearer " .. TOKEN, ["Content-Type"] = "application/json" },
    }
    if body ~= nil then request.Body = encode(body) end

    local ok, response = pcall(httpRequest, request)
    if not ok or type(response) ~= "table" then return nil, tostring(response) end
    if response.StatusCode ~= 200 then return nil, "HTTP " .. tostring(response.StatusCode) end

    local decoded, data = pcall(HttpService.JSONDecode, HttpService, response.Body)
    if not decoded then return nil, "bad JSON from server" end
    return data
end

local function serialize(values)
    local out = {}
    for i = 1, values.n do
        local v = values[i]
        local t = typeof(v)
        if t == "string" or t == "number" or t == "boolean" or v == nil then
            out[i] = v
        elseif t == "table" and encode(v) then
            out[i] = v
        else
            out[i] = tostring(v)
        end
    end
    return out
end

local function runJob(job)
    local reply = { id = job.id }
    local fn, compileError = loadstring(job.code)
    if not fn then
        reply.ok, reply.error = false, tostring(compileError)
    else
        local packed = table.pack(pcall(fn))
        if packed[1] then
            reply.ok = true
            reply.result = serialize(table.pack(table.unpack(packed, 2, packed.n)))
        else
            reply.ok, reply.error = false, tostring(packed[2])
        end
    end
    if not encode(reply) then
        reply = { id = job.id, ok = false, error = "result not serializable" }
    end
    call("POST", "/client/result", reply)
end

-- Run the autoexec code stored on the server, once per launch.
task.spawn(function()
    while active() do
        local data = call("GET", "/client/autoexec")
        if data then
            if type(data.code) == "string" then
                local fn, compileError = loadstring(data.code)
                if fn then
                    task.spawn(function()
                        local ok, runtimeError = pcall(fn)
                        if not ok then warn("[relay] autoexec error: " .. tostring(runtimeError)) end
                    end)
                else
                    warn("[relay] autoexec compile error: " .. tostring(compileError))
                end
            end
            return
        end
        task.wait(RETRY_DELAY)
    end
end)

-- Main loop: long-poll for jobs.
task.spawn(function()
    while active() do
        local data = call("POST", "/client/poll", {})
        if data then
            if data.job then task.spawn(runJob, data.job) end
        else
            task.wait(RETRY_DELAY)
        end
    end
end)

print("[relay] started")
