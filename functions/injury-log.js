const { Octokit } = require("@octokit/rest");

const { GITHUB_TOKEN, GITHUB_USER, GITHUB_REPO } = process.env;
const CONFIG_PATH = "data/app_info.csv";
const LOG_PATH = "data/injury_log.csv";
const SEASON_DATES_PATH = "data/season_dates.csv";
const SEASON_ROUNDS_PATH = "data/season_rounds.csv";

// Helper to check user's role. Only 'physio' can make changes.
function isAuthorized(context) {
    if (!context.clientContext || !context.clientContext.user) {
        return false; // No user logged in
    }
    const roles = context.clientContext.user.app_metadata.roles || [];
    return roles.includes('physio');
}

async function getFile(octokit, path) {
    try {
        const { data } = await octokit.repos.getContent({ owner: GITHUB_USER, repo: GITHUB_REPO, path });
        return { content: Buffer.from(data.content, 'base64').toString('utf8'), sha: data.sha };
    } catch (error) {
        if (error.status === 404) return { content: '', sha: null };
        throw error;
    }
}

// ... (All other parsing functions like parseAppConfig, parseSeasonDates, etc. remain the same)

exports.handler = async (event, context) => {
    if (!GITHUB_TOKEN || !GITHUB_USER || !GITHUB_REPO) {
        return { statusCode: 500, body: JSON.stringify({ error: "Missing required environment variables." }) };
    }
    const octokit = new Octokit({ auth: GITHUB_TOKEN });

    if (event.httpMethod === 'GET') {
        // GET requests are allowed for any logged-in user
        if (!context.clientContext || !context.clientContext.user) {
             return { statusCode: 401, body: "Unauthorized" };
        }
        // ... (The rest of the GET logic is the same)
    }

    if (event.httpMethod === 'POST') {
        // For ALL POST requests, first check if the user is a physio
        if (!isAuthorized(context)) {
            return { statusCode: 401, body: JSON.stringify({ error: "You are not authorized to make changes." }) };
        }
        
        const body = JSON.parse(event.body);
        // ... (All the POST logic for different actions remains the same)
    }

    return { statusCode: 405, body: "Method Not Allowed" };
};
