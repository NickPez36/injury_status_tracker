// This is the server-side code that will run on Netlify.
// It handles reading and writing to the injury_log.csv file in your GitHub repo.

const { Octokit } = require("@octokit/rest");

// --- CONFIGURATION ---
// These values are loaded from Netlify environment variables for security.
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_USER = process.env.GITHUB_USER;
const GITHUB_REPO = process.env.GITHUB_REPO;
const FILE_PATH = "data/injury_log.csv";

const octokit = new Octokit({ auth: GITHUB_TOKEN });

// Main function handler
exports.handler = async (event, context) => {
    if (event.httpMethod === 'GET') {
        return getInjuryData();
    } else if (event.httpMethod === 'POST') {
        return updateInjuryData(event);
    }

    return { statusCode: 405, body: "Method Not Allowed" };
};

// --- GET REQUEST HANDLER ---
async function getInjuryData() {
    try {
        const fileContent = await getFileFromGitHub();
        const injuryLog = parseCsv(fileContent);
        return {
            statusCode: 200,
            body: JSON.stringify(injuryLog),
        };
    } catch (error) {
        // If the file doesn't exist (e.g., first run), return an empty object.
        if (error.status === 404) {
            return { statusCode: 200, body: JSON.stringify({}) };
        }
        console.error("Error fetching data:", error);
        return { statusCode: 500, body: "Error fetching injury data." };
    }
}

// --- POST REQUEST HANDLER ---
async function updateInjuryData(event) {
    try {
        const newData = JSON.parse(event.body);
        const { key, ...statusData } = newData;

        if (!key) {
            return { statusCode: 400, body: "Missing 'key' in request body." };
        }

        const fileData = await getFileFromGitHub(true); // Get SHA as well
        let injuryLog = parseCsv(fileData.content);

        // Update the log in memory
        injuryLog[key] = statusData;

        const updatedCsvContent = convertLogToCsv(injuryLog);

        // Commit the updated file back to GitHub
        await octokit.repos.createOrUpdateFileContents({
            owner: GITHUB_USER,
            repo: GITHUB_REPO,
            path: FILE_PATH,
            message: `Update injury log for ${key} [skip ci]`,
            content: Buffer.from(updatedCsvContent).toString('base64'),
            sha: fileData.sha, // Must provide the SHA of the file being updated
        });

        return { statusCode: 200, body: "Update successful" };

    } catch (error) {
        console.error("Error updating data:", error);
        return { statusCode: 500, body: "Error updating injury data." };
    }
}

// --- GITHUB API HELPERS ---
async function getFileFromGitHub(getSha = false) {
    const { data } = await octokit.repos.getContent({
        owner: GITHUB_USER,
        repo: GITHUB_REPO,
        path: FILE_PATH,
    });
    const content = Buffer.from(data.content, 'base64').toString('utf8');
    return getSha ? { content, sha: data.sha } : content;
}

// --- CSV UTILITY FUNCTIONS ---
function parseCsv(csvText) {
    if (!csvText) return {};
    const lines = csvText.split('\n').filter(line => line.trim() !== '');
    const headers = lines.shift().split(',');
    
    const log = {};
    lines.forEach(line => {
        const values = line.split(',');
        const key = values[0];
        log[key] = {
            status: values[1] || '',
            injurySite: values[2] || '',
            injury: values[3] || '',
            severity: values[4] || '',
            comment: values[5] || '',
        };
    });
    return log;
}

function convertLogToCsv(log) {
    const headers = "key,status,injurySite,injury,severity,comment";
    const rows = Object.entries(log).map(([key, data]) => {
        return `${key},${data.status},${data.injurySite},${data.injury},${data.severity},${data.comment}`;
    });
    return [headers, ...rows].join('\n');
}

