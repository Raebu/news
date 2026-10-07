import { defineConfig } from "@neon/config/v1";

const optional = (name: string): string | undefined => process.env[name]?.trim() || undefined;

export default defineConfig({
  functions: {
    publishingapi: {
      name: "Raeburn Publishing API",
      source: "functions/publishing-api.ts",
      env: {
        NODE_ENV: "production",
        SERVICE_NAME: "publishing-api",
        SERVICE_SHARED_SECRET: process.env.SERVICE_SHARED_SECRET!,
        PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL ?? "https://theraeburngroup.com",
        AI_PUBLISHING_ENABLED: process.env.AI_PUBLISHING_ENABLED ?? "false"
      }
    },
    newsroomworker: {
      name: "Raeburn Newsroom Worker",
      source: "functions/newsroom-worker.ts",
      env: {
        NODE_ENV: "production",
        SERVICE_NAME: "publishing-worker",
        SERVICE_SHARED_SECRET: process.env.SERVICE_SHARED_SECRET!,
        PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL ?? "https://theraeburngroup.com",
        AI_PUBLISHING_ENABLED: process.env.AI_PUBLISHING_ENABLED ?? "false",
        OPENAI_API_KEY: process.env.OPENAI_API_KEY!,
        OPENAI_TEXT_MODEL: process.env.OPENAI_TEXT_MODEL ?? "gpt-5.6-luna",
        OPENAI_IMAGE_MODEL: process.env.OPENAI_IMAGE_MODEL ?? "gpt-image-2",
        CLOUDINARY_CLOUD_NAME: process.env.CLOUDINARY_CLOUD_NAME ?? "u7dpgaxh",
        CLOUDINARY_ASSET_FOLDER: process.env.CLOUDINARY_ASSET_FOLDER ?? "Cloudinary/The_Raeburn_Holding_Group_Ltd/news",
        CLOUDINARY_API_KEY: process.env.CLOUDINARY_API_KEY!,
        CLOUDINARY_API_SECRET: process.env.CLOUDINARY_API_SECRET!,
        ...(optional("RESEND_API_KEY") ? { RESEND_API_KEY: optional("RESEND_API_KEY")! } : {}),
        ...(optional("RESEND_FROM") ? { RESEND_FROM: optional("RESEND_FROM")! } : {}),
        ...(optional("RESEND_REPLY_TO") ? { RESEND_REPLY_TO: optional("RESEND_REPLY_TO")! } : {}),
        ...(optional("RESEND_SEGMENT_ID") ? { RESEND_SEGMENT_ID: optional("RESEND_SEGMENT_ID")! } : {}),
        ...(optional("DISTRIBUTION_WEBHOOK_URL") ? { DISTRIBUTION_WEBHOOK_URL: optional("DISTRIBUTION_WEBHOOK_URL")! } : {}),
        ...(optional("DISTRIBUTION_WEBHOOK_TOKEN") ? { DISTRIBUTION_WEBHOOK_TOKEN: optional("DISTRIBUTION_WEBHOOK_TOKEN")! } : {})
      }
    }
  },
  triggers: {
    "newsroom-pump": {
      type: "schedule",
      function: "newsroomworker",
      cron: "* * * * *"
    }
  }
});
