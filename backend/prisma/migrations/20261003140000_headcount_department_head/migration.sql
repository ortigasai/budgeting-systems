-- AlterTable
ALTER TABLE "AdditionalHeadcountRequest" ADD COLUMN "departmentHeadId" TEXT;

-- AddForeignKey
ALTER TABLE "AdditionalHeadcountRequest" ADD CONSTRAINT "AdditionalHeadcountRequest_departmentHeadId_fkey" FOREIGN KEY ("departmentHeadId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
