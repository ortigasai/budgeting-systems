-- AlterTable
ALTER TABLE "AdditionalHeadcountRequest" ALTER COLUMN "currentStage" SET DEFAULT 'DRAFT',
ALTER COLUMN "code" DROP NOT NULL;
