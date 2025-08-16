const { Octokit } = require("@octokit/rest");

const { GITHUB_TOKEN, GITHUB_USER, GITHUB_REPO } = process.env;
const LOG_PATH = "data/injury_log.csv";
const CONFIG_PATH = "data/app_info.csv";

const octokit = new Octokit({ auth: GITHUB_TOKEN });

// Fetches a file's content and SHA from the GitHub repository
async function getFile(path) {
    try {
        const { data } = await octokit.repos.getContent({ owner: GITHUB_USER, repo: GITHUB_REPO, path });
        return { content: Buffer.from(data.content, 'base64').toString('utf8'), sha: data.sha };
    } catch (error) {
        if (error.status === 404) return { content: '', sha: null };
        throw error;
    }
}

// Parses the main athlete list from app_info.csv
function getAthletesFromConfig(csvText) {
    const lines = csvText.split('\n').filter(line => line.trim());
    lines.shift(); // Remove header
    const athletes = new Set();
    lines.forEach(line => {
        const name = line.split(',')[0].trim();
        if (name) athletes.add(name);
    });
    return [...athletes];
}

// Parses the injury log CSV into a JavaScript object
function parseInjuryLog(csvText) {
    const lines = csvText.split('\n').filter(line => line.trim());
    if (lines.length <= 1) return {};
    lines.shift();
    const log = {};
    lines.forEach(line => {
        const [key, status, injurySite, injury, severity, comment] = line.split(',');
        if (key) log[key] = { status, injurySite, injury, severity, comment: comment || '' };
    });
    return log;
}

// Gets a date string in YYYY-MM-DD format
function toYYYYMMDD(date) { return date.toISOString().split('T')[0]; }

async function main() {
    console.log("Starting nightly injury log update...");

    const configFile = await getFile(CONFIG_PATH);
    if (!configFile.content) throw new Error("app_info.csv is empty or not found.");
    const athletes = getAthletesFromConfig(configFile.content);
    console.log(`Found ${athletes.length} athletes.`);

    const logFile = await getFile(LOG_PATH);
    const injuryLog = parseInjuryLog(logFile.content);

    const today = new Date();
    const tomorrow = new Date();
    tomorrow.setDate(today.getDate() + 1);
    const tomorrowStr = toYYYYMMDD(tomorrow);
    
    let updatesMade = false;

    for (const athlete of athletes) {
        const tomorrowKey = `${athlete}-${tomorrowStr}`;
        if (!injuryLog[tomorrowKey]) {
            let statusToCarryForward = { status: 'Available' };
            let date = new Date(today);
            for (let i = 0; i < 365; i++) {
                const key = `${athlete}-${toYYYYMMDD(date)}`;
                if (injuryLog[key]) {
                    statusToCarryForward = injuryLog[key];
                    break;
                }
                date.setDate(date.getDate() - 1);
            }
            console.log(`Updating ${athlete} for ${tomorrowStr} with status: ${statusToCarryForward.status}`);
            injuryLog[tomorrowKey] = statusToCarryForward;
            updatesMade = true;
        }
    }

    if (updatesMade) {
        const headers = "key,status,injurySite,injury,severity,comment";
        const rows = Object.entries(injuryLog).map(([k, v]) => `${k},${v.status || ''},${v.injurySite || ''},${v.injury || ''},${v.severity || ''},${v.comment || ''}`);
        const newContent = [headers, ...rows].join('\n');
        
        await octokit.repos.createOrUpdateFileContents({
            owner: GITHUB_USER, repo: GITHUB_REPO, path: LOG_PATH,
            message: `Automated nightly update for ${tomorrowStr} [skip ci]`,
            content: Buffer.from(newContent).toString('base64'),
            sha: logFile.sha
        });
        console.log("Successfully updated and committed injury_log.csv.");
    } else {
        console.log("No updates needed. Tomorrow's log is already populated.");
    }
}

main().catch(error => {
    console.error("Script failed:", error);
    process.exit(1);
});
