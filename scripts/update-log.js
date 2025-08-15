// This is the Node.js script that the GitHub Action will run every night.
// It reads the injury log, adds entries for the next day, and saves it back.

const { Octokit } = require("@octokit/rest");
const fs = require('fs').promises;

// --- CONFIGURATION ---
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_USER = process.env.GITHUB_USER;
const GITHUB_REPO = process.env.GITHUB_REPO;
const LOG_FILE_PATH = "data/injury_log.csv";
const CONFIG_FILE_PATH = "index.html"; // We need to read this to get the athlete list

const octokit = new Octokit({ auth: GITHUB_TOKEN });

// --- HELPER FUNCTIONS ---

// Fetches a file's content from the GitHub repository
async function getFileFromGitHub(filePath) {
    try {
        const { data } = await octokit.repos.getContent({
            owner: GITHUB_USER,
            repo: GITHUB_REPO,
            path: filePath,
        });
        const content = Buffer.from(data.content, 'base64').toString('utf8');
        return { content, sha: data.sha };
    } catch (error) {
        if (error.status === 404) {
            console.log(`${filePath} not found, starting fresh.`);
            return { content: '', sha: null };
        }
        throw error;
    }
}

// Parses the main athlete list from the embedded CSV in index.html
function getAthletesFromConfig(htmlContent) {
    const csvRegex = /const csvText = `([^`]+)`;/;
    const match = htmlContent.match(csvRegex);
    if (!match) throw new Error("Could not find embedded CSV in index.html");
    
    const lines = match[1].split('\n').filter(line => line.trim() !== '');
    lines.shift(); // Remove header
    const athletes = new Set();
    lines.forEach(line => {
        const name = line.split(',')[0].trim();
        if (name && name !== '-') athletes.add(name);
    });
    return [...athletes];
}

// Parses the injury log CSV into a JavaScript object
function parseCsv(csvText) {
    if (!csvText) return {};
    const log = {};
    const lines = csvText.split('\n').filter(line => line.trim() !== '');
    if (lines.length <= 1) return {}; // Empty or only header
    
    lines.shift(); // Remove header
    lines.forEach(line => {
        const [key, status, injurySite, injury, severity, comment] = line.split(',');
        log[key] = { status, injurySite, injury, severity, comment };
    });
    return log;
}

// Converts the log object back into a CSV string
function convertLogToCsv(log) {
    const headers = "key,status,injurySite,injury,severity,comment";
    const rows = Object.entries(log).map(([key, data]) => {
        return `${key},${data.status || ''},${data.injurySite || ''},${data.injury || ''},${data.severity || ''},${data.comment || ''}`;
    });
    return [headers, ...rows].join('\n');
}

// Gets a date string in YYYY-MM-DD format for a given date object
function toYYYYMMDD(date) {
    return date.toISOString().split('T')[0];
}

// --- MAIN LOGIC ---
async function main() {
    console.log("Starting nightly injury log update...");

    // 1. Get athlete list from the main config file
    const configFile = await getFileFromGitHub(CONFIG_FILE_PATH);
    const athletes = getAthletesFromConfig(configFile.content);
    console.log(`Found ${athletes.length} athletes.`);

    // 2. Get the current injury log
    const logFile = await getFileFromGitHub(LOG_FILE_PATH);
    const injuryLog = parseCsv(logFile.content);

    // 3. Determine today's and tomorrow's dates
    const today = new Date();
    const tomorrow = new Date();
    tomorrow.setDate(today.getDate() + 1);
    
    const todayStr = toYYYYMMDD(today);
    const tomorrowStr = toYYYYMMDD(tomorrow);
    
    let updatesMade = false;

    // 4. For each athlete, carry forward today's status to tomorrow
    for (const athlete of athletes) {
        const tomorrowKey = `${athlete}-${tomorrowStr}`;
        
        // Only add an entry if one doesn't already exist for tomorrow
        if (!injuryLog[tomorrowKey]) {
            let statusToCarryForward = { status: 'Available', injurySite: '', injury: '', severity: '', comment: '' };
            
            // Find the most recent status to carry forward
            let date = new Date(today);
            for (let i = 0; i < 365; i++) { // Look back up to a year
                const dateStr = toYYYYMMDD(date);
                const key = `${athlete}-${dateStr}`;
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

    // 5. If updates were made, save the file back to GitHub
    if (updatesMade) {
        const updatedCsvContent = convertLogToCsv(injuryLog);
        await octokit.repos.createOrUpdateFileContents({
            owner: GITHUB_USER,
            repo: GITHUB_REPO,
            path: LOG_FILE_PATH,
            message: `Automated nightly update for ${tomorrowStr} [skip ci]`,
            content: Buffer.from(updatedCsvContent).toString('base64'),
            sha: logFile.sha,
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
