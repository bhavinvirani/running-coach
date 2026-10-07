import {
  latestReviewResponseSchema,
  reviewFeedbackRequestSchema,
  reviewListResponseSchema,
  reviewParamsSchema,
  reviewResponseSchema,
} from "@running-coach/shared";
import { Router } from "express";
import { parse, respond } from "../lib/http";
import { getReview, latestReview, listReviews, setReviewFeedback } from "../services/weekly-review";

// The coach's weekly reviews: Today's latest, the past list and one review with its thumbs. No rate limit:
// they read and write the database only, and nothing here queues a Claude call.

export const reviewsRouter = Router();

// Before /reviews/:id, whose id must be a uuid.
reviewsRouter.get("/reviews/latest", async (req, res) => {
  respond(res, latestReviewResponseSchema, await latestReview(req.user.id));
});

reviewsRouter.get("/reviews", async (req, res) => {
  respond(res, reviewListResponseSchema, await listReviews(req.user.id));
});

reviewsRouter.get("/reviews/:id", async (req, res) => {
  const { id } = parse(reviewParamsSchema, req.params);
  respond(res, reviewResponseSchema, await getReview(req.user.id, id));
});

reviewsRouter.put("/reviews/:id/feedback", async (req, res) => {
  const { id } = parse(reviewParamsSchema, req.params);
  const { feedback } = parse(reviewFeedbackRequestSchema, req.body);
  respond(res, reviewResponseSchema, await setReviewFeedback(req.user.id, id, feedback));
});
