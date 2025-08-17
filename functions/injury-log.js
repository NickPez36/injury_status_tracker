const { Octokit } = require("@octokit/rest");

const { GITHUB_TOKEN, GITHUB_USER, GITHUB_REPO } = process.env;
const CONFIG_PATH = "data/app_info.csv";
const LOG_PATH = "data/injury_log.csv";
const SEASON_DATES_PATH = "data/season_dates.csv";

async function getFile(octokit, path) {
    try {
        const { data } = await octokit.repos.getContent({ owner: GITHUB_USER, repo: GITHUB_REPO, path });
        return { content: Buffer.from(data.content, 'base64').toString('utf8'), sha: data.sha };
    } catch (error) {
        if (error.status === 404) return { content: '', sha: null };
        throw error;
    }
}

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

function parseSeasonDates(csvText) {
    const lines = csvText.split('\n').filter(line => line.trim());
    if (lines.length <= 1) return [];
    lines.shift(); // Remove header
    const periodColors = { "Pre-Season": "#3182CE", "In-Season": "#63B3ED", "Off-Season": "#718096" };
    return lines.map(line => {
        const [Year, Period, StartDate, EndDate] = line.split(',');
        return { Year, Period, StartDate, EndDate, Color: periodColors[Period] || "#A0AEC0" };
    });
}

function parseInjuryLog(csvText) {
    const lines = csvText.split('\n').filter(line => line.trim());
    if (lines.length <= 1) return {};
    lines.shift();
    const log = {};
    lines.forEach(line => {
        const [key, status, injurySite, injury, severity, comment] = line.split(',');
        if (key) log[key] = { status, injurySite, injury, severity, comment: (comment || '').trim() };
    });
    return log;
}

exports.handler = async (event) => {
    if (!GITHUB_TOKEN || !GITHUB_USER || !GITHUB_REPO) {
        return { statusCode: 500, body: JSON.stringify({ error: "Missing required environment variables." }) };
    }
    const octokit = new Octokit({ auth: GITHUB_TOKEN });

    if (event.httpMethod === 'GET') {
        if (event.queryStringParameters.config === 'true') {
            const [configFile, seasonFile] = await Promise.all([
                getFile(octokit, CONFIG_PATH),
                getFile(octokit, SEASON_DATES_PATH)
            ]);
            const appConfig = parseAppConfig(configFile.content);
            appConfig.seasonPeriods = parseSeasonDates(seasonFile.content);
            return { statusCode: 200, body: JSON.stringify(appConfig) };
        }
        const logFile = await getFile(octokit, LOG_PATH);
        const injuryLog = parseInjuryLog(logFile.content);
        return { statusCode: 200, body: JSON.stringify(injuryLog) };
    }

    if (event.httpMethod === 'POST') {
        const body = JSON.parse(event.body);

        if (body.action === 'updateSeasonDates') {
            const { seasons } = body;
            const headers = "Year,Period,StartDate,EndDate";
            const rows = seasons.map(s => `${s.Year},${s.Period},${s.StartDate},${s.EndDate}`);
            const newContent = [headers, ...rows].join('\n');
            const seasonFile = await getFile(octokit, SEASON_DATES_PATH);
            await octokit.repos.createOrUpdateFileContents({
                owner: GITHUB_USER, repo: GITHUB_REPO, path: SEASON_DATES_PATH,
                message: `chore: Update season dates [skip ci]`,
                content: Buffer.from(newContent).toString('base64'),
                sha: seasonFile.sha
            });
            return { statusCode: 200, body: JSON.stringify({ message: "Season dates updated" }) };
        }

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

        if (body.action === 'deletePlayer') {
            const { name } = body;
            const configFile = await getFile(octokit, CONFIG_PATH);
            const configLines = configFile.content.split('\n');
            const newConfigLines = configLines.filter(line => line.split(',')[0].trim() !== name);
            await octokit.repos.createOrUpdateFileContents({
                owner: GITHUB_USER, repo: GITHUB_REPO, path: CONFIG_PATH,
                message: `feat: Delete player ${name} [skip ci]`,
                content: Buffer.from(newConfigLines.join('\n')).toString('base64'),
                sha: configFile.sha
            });

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
        
        if (body.action === 'batchUpdateLog') {
            const { payload } = body;
            const logFile = await getFile(octokit, LOG_PATH);
            const injuryLog = parseInjuryLog(logFile.content);
            payload.forEach(item => { injuryLog[item.key] = item.data; });
            const headers = "key,status,injurySite,injury,severity,comment";
            const rows = Object.entries(injuryLog).map(([k, v]) => `${k},${v.status || ''},${v.injurySite || ''},${v.injury || ''},${v.severity || ''},${v.comment || ''}`);
            const newContent = [headers, ...rows].join('\n');
            await octokit.repos.createOrUpdateFileContents({
                owner: GITHUB_USER, repo: GITHUB_REPO, path: LOG_PATH,
                message: `chore: Batch update log [skip ci]`,
                content: Buffer.from(newContent).toString('base64'),
                sha: logFile.sha
            });
            return { statusCode: 200, body: JSON.stringify({ message: "Batch update successful" }) };
        }
    }

    return { statusCode: 405, body: "Method Not Allowed" };
};
