const REPO_API_URL = "https://api.github.com/repos/jasiek/webchirp";

function formatStarCount(count) {
  return new Intl.NumberFormat("en", {
    notation: count >= 1000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(count);
}

async function loadGitHubStarCount() {
  const countLink = document.getElementById("github-star-count");
  if (!(countLink instanceof HTMLAnchorElement)) {
    return;
  }

  try {
    const response = await fetch(REPO_API_URL, {
      headers: {
        Accept: "application/vnd.github+json",
      },
      mode: "cors",
    });
    if (!response.ok) {
      throw new Error(`GitHub API returned ${response.status}`);
    }

    const repo = await response.json();
    const stars = Number(repo?.stargazers_count);
    if (!Number.isFinite(stars) || stars < 0) {
      throw new Error("GitHub API response did not include a valid stargazers_count");
    }

    countLink.textContent = formatStarCount(stars);
    countLink.hidden = false;
  } catch (error) {
    console.warn("Unable to load GitHub star count", error);
  }
}

void loadGitHubStarCount();
