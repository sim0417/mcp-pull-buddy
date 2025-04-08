import { Octokit, type RestEndpointMethodTypes } from "@octokit/rest";
import { CacheStore } from "./cache.js";

export type PullRequests =
  RestEndpointMethodTypes["pulls"]["list"]["response"]["data"];

export type Collaborator =
  RestEndpointMethodTypes["orgs"]["listMembers"]["response"]["data"];

export type ReviewState = Record<string, number>;

export type PullRequestParams = {
  owner: string;
  repo: string;
  pullNumber: number;
} | null;

export type ReviewComment = {
  id: number;
  prNumber: number;
  author: string;
  body: string;
  createdAt: string;
  path?: string;
  line?: number;
  commitId?: string;
};

export type ReviewHistory = {
  reviewer: {
    login: string;
    name: string | null;
  };
  reviews: Array<{
    prNumber: number;
    submittedAt: string;
    comments: ReviewComment[];
  }>;
  stats: {
    totalReviews: number;
    totalComments: number;
    averageResponseTime: number;
    lastReviewAt: string;
    relatedFileChanges: number;
  };
};

export interface RateLimit {
  limit: number;
  remaining: number;
  reset: Date;
  used: number;
}

// PR과 리뷰 데이터를 위한 캐시 저장소
const pullRequestsCache = new CacheStore<
  RestEndpointMethodTypes["pulls"]["list"]["response"]["data"]
>();
const reviewsCache = new CacheStore<
  RestEndpointMethodTypes["pulls"]["listReviews"]["response"]["data"]
>();
const filesCache = new CacheStore<
  RestEndpointMethodTypes["pulls"]["listFiles"]["response"]["data"]
>();

function getPRCacheKey(owner: string, repo: string): string {
  return `pr:${owner}:${repo}`;
}

function getReviewsCacheKey(
  owner: string,
  repo: string,
  prNumber: number
): string {
  return `review:${owner}:${repo}:${prNumber}`;
}

function getFilesCacheKey(
  owner: string,
  repo: string,
  prNumber: number
): string {
  return `files:${owner}:${repo}:${prNumber}`;
}

// Rate limit 확인 함수
export const getRateLimit = async (): Promise<RateLimit> => {
  const octokit = getOctokit();
  const { data } = await octokit.rest.rateLimit.get();

  return {
    limit: data.rate.limit,
    remaining: data.rate.remaining,
    reset: new Date(data.rate.reset * 1000),
    used: data.rate.used,
  };
};

const getOctokit = (): Octokit => {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("GITHUB_TOKEN is not set");
  }
  return new Octokit({
    auth: token,
  });
};

export const getPullRequestByOwner = async (
  owner: string
): Promise<PullRequests> => {
  const octokit = getOctokit();

  const pullRequests: PullRequests = [];

  const { data: repos } = await octokit.rest.repos.listForOrg({
    org: owner,
  });

  for (const repo of repos) {
    const { data: pullRequests } = await octokit.rest.pulls.list({
      owner,
      repo: repo.name,
    });
    pullRequests.push(...pullRequests);
  }
  return pullRequests;
};

export const getReviewRequestsPerUser = async (
  owner: string
): Promise<ReviewState> => {
  const pullRequests = await getPullRequestByOwner(owner);
  const reviewStates: ReviewState = {};

  // 모든 PR에 대해 요청된 리뷰어정보를 수집
  for (const pullRequest of pullRequests) {
    if (pullRequest.requested_reviewers) {
      for (const reviewer of pullRequest.requested_reviewers) {
        const login = reviewer.login;
        reviewStates[login] = (reviewStates[login] || 0) + 1;
      }
    }
  }
  return reviewStates;
};

export const getReviewBuddy = async (owner: string): Promise<Collaborator> => {
  const octokit = getOctokit();

  const { data: members } = await octokit.rest.orgs.listMembers({
    org: owner,
  });

  // 각 멤버의 상세 정보를 가져온다
  const membersWithDetails = await Promise.all(
    members.map(async (member) => {
      try {
        const { data: userDetails } = await octokit.rest.users.getByUsername({
          username: member.login,
        });
        return { ...member, name: userDetails.name };
      } catch (error) {
        console.error(
          `Error fetching details for user ${member.login}:`,
          error
        );
        return member;
      }
    })
  );

  return membersWithDetails;
};

export const parsePullRequestUrl = (url: string): PullRequestParams => {
  const regex = /https?:\/\/github\.com\/([^\/]+)\/([^\/]+)\/pull\/(\d+)/;
  const match = url.match(regex);

  if (!match) {
    return null;
  }

  return {
    owner: match[1],
    repo: match[2],
    pullNumber: Number.parseInt(match[3], 10),
  };
};

export const getPullRequestDetails = async (params: PullRequestParams) => {
  const octokit = getOctokit();
  if (!params) {
    throw new Error("Invalid pull request URL");
  }
  const { owner, repo, pullNumber } = params;

  const { data: pr } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: pullNumber,
  });

  try {
    // PR 파일 목록 가져오기
    const { data: files } = await octokit.rest.pulls.listFiles({
      owner,
      repo,
      pull_number: pullNumber,
    });

    const reviewers = pr.requested_reviewers || [];

    return {
      pr,
      files,
      reviewers,
    };
  } catch (error) {
    console.error("Error fetching pull request details:", error);
    return null;
  }
};

export const getReviewHistory = async (
  owner: string,
  repo: string,
  reviewer: string,
  since: Date = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) // 최근 30일
): Promise<ReviewHistory> => {
  const octokit = getOctokit();

  // 1. 저장소의 모든 PR 가져오기 (캐시 적용)
  const prCacheKey = getPRCacheKey(owner, repo);
  let pullRequests = pullRequestsCache.get(prCacheKey);

  if (!pullRequests) {
    const { data } = await octokit.rest.pulls.list({
      owner,
      repo,
      state: "all",
      sort: "updated",
      direction: "desc",
      per_page: 100,
    });
    pullRequests = data;
    pullRequestsCache.set(prCacheKey, data);
  }

  const reviews = [];
  let totalComments = 0;
  let totalResponseTime = 0;
  let lastReviewAt = "";

  // 2. 각 PR의 리뷰 정보 수집
  for (const pr of pullRequests) {
    // PR 생성 시점이 since보다 이전이면 건너뛰기
    if (new Date(pr.created_at) < since) continue;

    // 리뷰 정보 가져오기 (캐시 적용)
    const reviewsCacheKey = getReviewsCacheKey(owner, repo, pr.number);
    let prReviews = reviewsCache.get(reviewsCacheKey);

    if (!prReviews) {
      const { data } = await octokit.rest.pulls.listReviews({
        owner,
        repo,
        pull_number: pr.number,
      });
      prReviews = data;
      reviewsCache.set(reviewsCacheKey, data);
    }

    // 해당 리뷰어의 리뷰만 필터링
    const reviewerReviews = prReviews.filter(
      (review) => review.user?.login === reviewer
    );

    for (const review of reviewerReviews) {
      const { data: comments } = await octokit.rest.pulls.listReviewComments({
        owner,
        repo,
        pull_number: pr.number,
        review_id: review.id,
      });

      const formattedComments: ReviewComment[] = comments.map((comment) => ({
        id: comment.id,
        prNumber: pr.number,
        author: comment.user?.login || "",
        body: comment.body || "",
        createdAt: comment.created_at,
        path: comment.path,
        line: comment.line,
        commitId: comment.commit_id,
      }));

      reviews.push({
        prNumber: pr.number,
        submittedAt: review.submitted_at || "",
        comments: formattedComments,
      });

      totalComments += formattedComments.length;

      // 응답 시간 계산 (PR 생성 시점부터 첫 리뷰까지)
      const responseTime =
        new Date(review.submitted_at ?? pr.created_at).getTime() -
        new Date(pr.created_at).getTime();
      totalResponseTime += responseTime;

      // 가장 최근 리뷰 시점 업데이트
      if (
        !lastReviewAt ||
        (review.submitted_at && review.submitted_at > lastReviewAt)
      ) {
        lastReviewAt = review.submitted_at ?? lastReviewAt;
      }
    }
  }

  // 3. 통계 계산
  const stats = {
    totalReviews: reviews.length,
    totalComments,
    averageResponseTime:
      reviews.length > 0 ? totalResponseTime / reviews.length : 0,
    lastReviewAt,
    relatedFileChanges: 0,
  };

  return {
    reviewer: {
      login: reviewer,
      name: null,
    },
    reviews,
    stats,
  };
};

// 현재 PR과 관련된 파일 변경 경험 계산
export const calculateRelatedFileExperience = async (
  owner: string,
  repo: string,
  prNumber: number,
  reviewer: string
): Promise<number> => {
  const octokit = getOctokit();

  // 1. 현재 PR의 변경된 파일 목록 가져오기 (캐시 적용)
  const filesCacheKey = getFilesCacheKey(owner, repo, prNumber);
  let prFiles = filesCache.get(filesCacheKey);

  if (!prFiles) {
    const { data } = await octokit.rest.pulls.listFiles({
      owner,
      repo,
      pull_number: prNumber,
    });
    prFiles = data;
    filesCache.set(filesCacheKey, data);
  }

  const currentFiles = new Set(prFiles.map((file) => file.filename));

  // 2. 캐시된 PR 목록 가져오기
  const prCacheKey = getPRCacheKey(owner, repo);
  let pullRequests = pullRequestsCache.get(prCacheKey);

  if (!pullRequests) {
    const { data } = await octokit.rest.pulls.list({
      owner,
      repo,
      state: "all",
      sort: "updated",
      direction: "desc",
      per_page: 100,
    });
    pullRequests = data;
    pullRequestsCache.set(prCacheKey, data);
  }

  let relatedChanges = 0;

  // 3. 리뷰어가 참여한 PR들의 파일 변경 확인
  for (const pr of pullRequests) {
    // 리뷰 정보 가져오기 (캐시 적용)
    const reviewsCacheKey = getReviewsCacheKey(owner, repo, pr.number);
    let prReviews = reviewsCache.get(reviewsCacheKey);

    if (!prReviews) {
      const { data } = await octokit.rest.pulls.listReviews({
        owner,
        repo,
        pull_number: pr.number,
      });
      prReviews = data;
      reviewsCache.set(reviewsCacheKey, data);
    }

    // 해당 리뷰어의 리뷰가 있는지 확인
    const hasReviewed = prReviews.some(
      (review) => review.user?.login === reviewer
    );

    if (hasReviewed) {
      // PR의 파일 목록 가져오기 (캐시 적용)
      const prFilesCacheKey = getFilesCacheKey(owner, repo, pr.number);
      let reviewFiles = filesCache.get(prFilesCacheKey);

      if (!reviewFiles) {
        const { data } = await octokit.rest.pulls.listFiles({
          owner,
          repo,
          pull_number: pr.number,
        });
        reviewFiles = data;
        filesCache.set(prFilesCacheKey, data);
      }

      // 현재 PR의 파일과 겹치는 파일이 있는지 확인
      if (reviewFiles.some((file) => currentFiles.has(file.filename))) {
        relatedChanges++;
      }
    }
  }

  return relatedChanges;
};
