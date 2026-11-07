import { z } from 'zod';
import { DraftType, Intent, LeadStage, OpportunityLevel } from './enums';

/** Output of the score_opportunity tool. */
export const ScoreResult = z.object({
  score: z.number().int().min(0).max(100),
  level: z.enum(OpportunityLevel),
  intent: z.enum(Intent),
  reason: z.string().min(1).max(400),
  competitors: z.array(z.string()).default([]),
});
export type ScoreResult = z.infer<typeof ScoreResult>;

export const RuleLevel = z.enum(['block', 'warn']);
export const RuleCheck = z.object({
  key: z.string(),
  label: z.string(),
  level: RuleLevel,
  passed: z.boolean(),
  detail: z.string(),
});
export type RuleCheck = z.infer<typeof RuleCheck>;

export const ApproveDraftInput = z.object({ draftId: z.string(), body: z.string().min(1).optional() });
export const RejectDraftInput = z.object({ draftId: z.string(), reason: z.string().trim().min(3) });
export const RegenerateDraftInput = z.object({ draftId: z.string(), instruction: z.string().trim().min(3) });
export const ScheduleDraftInput = z.object({ draftId: z.string(), at: z.coerce.date() });
export const MoveLeadStageInput = z.object({ leadId: z.string(), stage: z.enum(LeadStage) });
export const DraftTypeSchema = z.enum(DraftType);

export const CollectBeacon = z.object({
  ws: z.string().min(1),
  vid: z.string().min(8).max(64),
  kind: z.enum(['pageview', 'signup', 'trial']),
  email: z.string().email().optional(),
  url: z.string().url().optional(),
  ref: z.string().optional(),
});
export type CollectBeacon = z.infer<typeof CollectBeacon>;
