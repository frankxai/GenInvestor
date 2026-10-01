import { loadWorkspace } from "@/lib/workspace";
import { WorkspaceUI } from "@/components/workspace";
export const dynamic = "force-dynamic";
export default function Page() {
  return <WorkspaceUI workspace={loadWorkspace()} />;
}
