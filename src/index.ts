import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import dotenv from "dotenv";
import { z } from "zod";
import {
  type PullRequests,
  calculateRelatedFileExperience,
  getPullRequestByOwner,
  getPullRequestDetails,
  getRateLimit,
  getReviewBuddy,
  getReviewHistory,
  getReviewRequestsPerUser,
  parsePullRequestUrl,
} from "./github.js";

dotenv.config();

const initServer = async () => {
  const server = new McpServer({
    name: "mcp-pull-buddy",
    version: "0.1.0",
  });

  // github PR 목록을 리소스로 정의
  server.resource(
    "pull-requests",
    "pull-requests://list/{owner}",
    async (uri, context) => {
      const owner = uri.pathname.split("/")[1];
      if (!owner) {
        throw new Error("owner 파라미터가 필요합니다");
      }

      const pullRequests: PullRequests = await getPullRequestByOwner(owner);
      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify(pullRequests),
          },
        ],
      };
    }
  );

  // PR 상세 정보를 리소스로 정의
  server.resource(
    "pr-details",
    "pr-details://list/{owner}/{repo}/{pullNumber}",
    async (uri, context) => {
      const owner = uri.pathname.split("/")[1];
      const repo = uri.pathname.split("/")[2];
      const pullNumber = uri.pathname.split("/")[3];

      if (!owner || !repo || !pullNumber) {
        throw new Error("owner, repo, pullNumber 파라미터가 필요합니다");
      }

      const prDetails = await getPullRequestDetails({
        owner,
        repo,
        pullNumber: Number.parseInt(pullNumber),
      });

      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify(prDetails),
          },
        ],
      };
    }
  );

  // 리뷰어의 요청 현황을 리소스로 정의
  server.resource(
    "review-states",
    "review-states://summary/{owner}",
    async (uri, context) => {
      const owner = uri.pathname.split("/")[1];
      if (!owner) {
        throw new Error("owner 파라미터가 필요합니다");
      }

      const states = await getReviewRequestsPerUser(owner);
      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify(states),
          },
        ],
      };
    }
  );

  // 리뷰를 해줄 수 있는 사람들을 리소스로 정의
  server.resource(
    "review-buddy",
    "review-buddy://list/{owner}",
    async (uri, context) => {
      const owner = uri.pathname.split("/")[1];
      if (!owner) {
        throw new Error("owner 파라미터가 필요합니다");
      }

      const reviewBuddy = await getReviewBuddy(owner);
      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify(reviewBuddy),
          },
        ],
      };
    }
  );

  // 리뷰어의 리뷰 히스토리를 리소스로 정의
  server.resource(
    "review-history",
    "review-history://list/{owner}/{repo}/{reviewer}",
    async (uri, context) => {
      const owner = uri.pathname.split("/")[1];
      const repo = uri.pathname.split("/")[2];
      const reviewer = uri.pathname.split("/")[3];

      if (!owner || !repo || !reviewer) {
        throw new Error("owner, repo, reviewer 파라미터가 필요합니다");
      }

      const reviewHistory = await getReviewHistory(owner, repo, reviewer);
      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify(reviewHistory),
          },
        ],
      };
    }
  );

  server.tool(
    "find-pr-buddy",
    {
      prUrl: z.string(),
      count: z.number().optional(),
    },
    async ({ prUrl, count = 10 }, context) => {
      const prParams = parsePullRequestUrl(prUrl);
      if (!prParams) {
        return {
          content: [
            {
              type: "text",
              text: "유효하지 않은 PR URL입니다. GitHub PR 링크 형식이어야 합니다.",
            },
          ],
          isError: true,
        };
      }

      const prDetails = await getPullRequestDetails(prParams);
      if (!prDetails) {
        return {
          content: [
            {
              type: "text",
              text: `PR 상세 정보를 가져오는데 실패했습니다. ${prParams}`,
            },
          ],
          isError: true,
        };
      }

      const buddies = await getReviewBuddy(prParams.owner);
      const reviewStates = await getReviewRequestsPerUser(prParams.owner);

      // 각 리뷰어의 리뷰 히스토리와 파일 관련성 가져오기
      const reviewerDetails = await Promise.all(
        buddies
          .filter((buddy) => {
            // 작성자 자신은 제외, 이미 리뷰어 목록에 있는 경우 제외
            return (
              !prDetails.reviewers.some((r) => r.login === buddy.login) ||
              buddy.login !== prDetails.pr.user.login
            );
          })
          .map(async (reviewer) => {
            const history = await getReviewHistory(
              prParams.owner,
              prParams.repo,
              reviewer.login
            );
            const relatedFileExperience = await calculateRelatedFileExperience(
              prParams.owner,
              prParams.repo,
              prParams.pullNumber,
              reviewer.login
            );

            return {
              login: reviewer.login,
              name: reviewer.name,
              pendingReviews: reviewStates[reviewer.login] || 0,
              stats: {
                ...history.stats,
                relatedFileChanges: relatedFileExperience,
              },
              recentComments: history.reviews
                .flatMap((r) => r.comments)
                .map((c) => c.body)
                .slice(0, 10), // 최근 10개 코멘트만 저장
            };
          })
      );

      // 리뷰어 점수 계산 및 정렬
      const scoredReviewers = reviewerDetails
        .map((reviewer) => {
          const score =
            (1 / (reviewer.pendingReviews + 1)) * 0.3 + // 대기 중인 리뷰가 적을수록 높은 점수
            (reviewer.stats.relatedFileChanges / 10) * 0.4 + // 관련 파일 경험
            (reviewer.stats.totalReviews / 50) * 0.3; // 전체 리뷰 경험

          return {
            ...reviewer,
            score,
          };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, count);

      return {
        content: [
          {
            type: "text",
            text: "본 정보는 최근 30일 동안의 리뷰 히스토리와 파일 관련성을 기반으로 계산되었습니다.",
          },
          {
            type: "text",
            text: `총 ${reviewerDetails.length}명의 리뷰어 중 상위 ${count}명을 추천합니다.`,
          },
          {
            type: "text",
            text: JSON.stringify(
              scoredReviewers.map((r) => ({
                login: r.login,
                name: r.name,
                score: r.score.toFixed(2),
                stats: {
                  pendingReviews: r.pendingReviews,
                  relatedFileChanges: r.stats.relatedFileChanges,
                  totalReviews: r.stats.totalReviews,
                  recentComments: r.recentComments,
                },
              })),
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.tool("check-github-rate-limit", {}, async (_, context) => {
    const rateLimit = await getRateLimit();
    return {
      content: [{ type: "text", text: JSON.stringify(rateLimit, null, 2) }],
    };
  });

  server.tool("hello world", { message: z.string() }, async ({ message }) => {
    return {
      content: [
        {
          type: "text",
          text: `Hello ${message}`,
        },
      ],
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
};

const runServer = async () => {
  try {
    if (!process.env.GITHUB_TOKEN) {
      console.error("GITHUB_TOKEN is not set");
      process.exit(1);
    }
    await initServer();
  } catch (error) {
    console.error(`Run server error: ${error}`);
  }
};

runServer();
