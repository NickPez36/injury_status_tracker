const { Octokit } = require("@octokit/rest");

const { GITHUB_TOKEN, GITHUB_USER, GITHUB_REPO } = process.env;
const CONFIG_PATH = "data/app_info.csv";
const LOG_PATH = "data/injury_log.csv";

// Helper to get file content and SHA from GitHub
async function getFile(octokit, path) {
    try {
        const { data } = await octokit.repos.getContent({ owner: GITHUB_USER, repo: GITHUB_REPO, path });
        return {
            content: Buffer.from(data.content, 'base64').toString('utf8'),
            sha: data.sha
        };
    } catch (error) {
        if (error.status === 404) return { content: '', sha: null };
        throw error;
    }
}

// Helper to parse the main app_info.csv
function parseAppConfig(csvText) {
    const lines = csvText.split('\n').filter(line => line.trim());
    const headers = lines.shift()?.split(',').map(h => h.trim()) || [];
    const data = lines.map(line => {
        const values = line.split(',').map(v => v.trim());
        let obj = {};
        headers.forEach((h, i) => obj[h] = values[i]);
        return obj;
    });
    return {
        athletes: [...new Set(data.map(item => item.AthleteName).filter(Boolean))].sort(),
        injurySites: [...new Set(data.map(item => item.InjurySite).filter(Boolean))],
        injuries: [...new Set(data.map(item => item.Injury).filter(Boolean))],
        severities: [...new Set(data.map(item => item.Severity).filter(Boolean))],
        statuses: [...new Set(data.map(item => item.Status).filter(Boolean).filter(s => s !== 'Pending'))],
        colorMap: data.reduce((acc, item) => {
            if (item.Status && item.ColourCode) acc[item.Status] = item.ColourCode;
            return acc;
        }, {})
    };
}

// Helper to parse the injury_log.csv
function parseInjuryLog(csvText) {
    const lines = csvText.split('\n').filter(line => line.trim());
    if (lines.length <= 1) return {};
    lines.shift(); // remove header
    const log = {};
    lines.forEach(line => {
        const [key, status, injurySite, injury, severity, comment] = line.split(',');
        if (key) log[key] = { status, injurySite, injury, severity, comment: comment || '' };
    });
    return log;
}

// Helper to convert an object to a CSV string
function toCsv(data, headers) {
    const rows = data.map(row => headers.map(header => row[header] || '').join(','));
    return [headers.join(','), ...rows].join('\n');
}

exports.handler = async (event) => {
    if (!GITHUB_TOKEN || !GITHUB_USER || !GITHUB_REPO) {
        return { statusCode: 500, body: JSON.stringify({ error: "Missing required environment variables." }) };
    }
    const octokit = new Octokit({ auth: GITHUB_TOKEN });

    // --- GET REQUESTS ---
    if (event.httpMethod === 'GET') {
        if (event.queryStringParameters.config === 'true') {
            const configFile = await getFile(octokit, CONFIG_PATH);
            const appConfig = parseAppConfig(configFile.content);
            return { statusCode: 200, body: JSON.stringify(appConfig) };
        }
        const logFile = await getFile(octokit, LOG_PATH);
        const injuryLog = parseInjuryLog(logFile.content);
        return { statusCode: 200, body: JSON.stringify(injuryLog) };
    }

    // --- POST REQUESTS ---
    if (event.httpMethod === 'POST') {
        const body = JSON.parse(event.body);

        // --- ADD PLAYER ACTION ---
        if (body.action === 'addPlayer') {
            const { name } = body;
            const configFile = await getFile(octokit, CONFIG_PATH);
            const newContent = `${configFile.content.trim()}\n${name},,,,,,\n`;
            await octokit.repos.createOrUpdateFileContents({
                owner: GITHUB_USER, repo: GITHUB_REPO, path: CONFIG_PATH,
                message: `feat: Add player ${name} [skip ci]`,
                content: Buffer.from(newContent).toString('base64'),
                sha: configFile.sha
            });
            return { statusCode: 200, body: JSON.stringify({ message: "Player added" }) };
        }

        // --- DELETE PLAYER ACTION ---
        if (body.action === 'deletePlayer') {
            const { name } = body;
            // Delete from config file
            const configFile = await getFile(octokit, CONFIG_PATH);
            const lines = configFile.content.split('\n').filter(line => line.trim());
            const headers = lines.shift().split(',');
            const updatedLines = lines.filter(line => line.split(',')[0].trim() !== name);
            const newConfigContent = [headers.join(','), ...updatedLines].join('\n');
            await octokit.repos.createOrUpdateFileContents({
                owner: GITHUB_USER, repo: GITHUB_REPO, path: CONFIG_PATH,
                message: `feat: Delete player ${name} [skip ci]`,
                content: Buffer.from(newConfigContent).toString('base64'),
                sha: configFile.sha
            });

            // Delete from log file
            const logFile = await getFile(octokit, LOG_PATH);
            const injuryLog = parseInjuryLog(logFile.content);
            const updatedLog = Object.fromEntries(Object.entries(injuryLog).filter(([key]) => !key.startsWith(name)));
            const logHeaders = "key,status,injurySite,injury,severity,comment";
            const logRows = Object.entries(updatedLog).map(([k, v]) => `${k},${v.status || ''},${v.injurySite || ''},${v.injury || ''},${v.severity || ''},${v.comment || ''}`);
            const newLogContent = [logHeaders, ...logRows].join('\n');
            await octokit.repos.createOrUpdateFileContents({
                owner: GITHUB_USER, repo: GITHUB_REPO, path: LOG_PATH,
                message: `chore: Prune log data for deleted player ${name} [skip ci]`,
                content: Buffer.from(newLogContent).toString('base64'),
                sha: logFile.sha
            });
            return { statusCode: 200, body: JSON.stringify({ message: "Player deleted" }) };
        }
        
        // --- BATCH UPDATE LOG ACTION (for back-filling) ---
        if (body.action === 'batchUpdateLog') {
            const { payload } = body;
            const logFile = await getFile(octokit, LOG_PATH);
            const injuryLog = parseInjuryLog(logFile.content);
            payload.forEach(item => {
                injuryLog[item.key] = item.data;
            });
            const headers = "key,status,injurySite,injury,severity,comment";
            const rows = Object.entries(injuryLog).map(([k, v]) => `${k},${v.status || ''},${v.injurySite || ''},${v.injury || ''},${v.severity || ''},${v.comment || ''}`);
            const newContent = [headers, ...rows].join('\n');
            await octokit.repos.createOrUpdateFileContents({
                owner: GITHUB_USER, repo: GITHUB_REPO, path: LOG_PATH,
                message: `chore: Batch update for initial data back-fill [skip ci]`,
                content: Buffer.from(newContent).toString('base64'),
                sha: logFile.sha
            });
            return { statusCode: 200, body: JSON.stringify({ message: "Batch update successful" }) };
        }


        // --- UPDATE LOG ACTION ---
        if (body.action === 'updateLog') {
            const { key, data } = body;
            const logFile = await getFile(octokit, LOG_PATH);
            const injuryLog = parseInjuryLog(logFile.content);
            injuryLog[key] = data;

            const headers = "key,status,injurySite,injury,severity,comment";
            const rows = Object.entries(injuryLog).map(([k, v]) => `${k},${v.status || ''},${v.injurySite || ''},${v.injury || ''},${v.severity || ''},${v.comment || ''}`);
            const newContent = [headers, ...rows].join('\n');

            await octokit.repos.createOrUpdateFileContents({
                owner: GITHUB_USER, repo: GITHUB_REPO, path: LOG_PATH,
                message: `Update injury log for ${key} [skip ci]`,
                content: Buffer.from(newContent).toString('base64'),
                sha: logFile.sha
            });
            return { statusCode: 200, body: JSON.stringify({ message: "Log updated" }) };
        }
    }

    return { statusCode: 405, body: "Method Not Allowed" };
};
