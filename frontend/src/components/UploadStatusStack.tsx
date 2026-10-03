import { useEffect } from "react";
import { dismissUploadTask, useAllUploadTasks, type UploadTask } from "../lib/uploadManager";

// Persistent, mounted once in App.tsx (outside <Routes>) so an upload's
// progress and completion toast survive navigating to a different page
// mid-upload - see uploadManager.ts for why the request itself already
// survives; this is just somewhere for the result to stay visible.
export function UploadStatusStack() {
  const tasks = useAllUploadTasks();
  if (tasks.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 w-80 space-y-2">
      {tasks.map((t) => (
        <UploadTaskCard key={t.id} task={t} />
      ))}
    </div>
  );
}

function UploadTaskCard({ task }: { task: UploadTask }) {
  useEffect(() => {
    if (task.status !== "success") return;
    const timer = setTimeout(() => dismissUploadTask(task.id), 8000);
    return () => clearTimeout(timer);
  }, [task.status, task.id]);

  const tone = task.status === "error" ? "border-red-300 bg-red-50 text-red-800" : task.status === "success" ? "border-emerald-300 bg-emerald-50 text-emerald-800" : "border-slate-300 bg-white text-slate-700";

  return (
    <div className={`rounded-lg border p-3 text-xs shadow-lg ${tone}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="font-medium">{task.label}</div>
        <button onClick={() => dismissUploadTask(task.id)} className="text-slate-400 hover:text-slate-600" aria-label="Dismiss">
          ×
        </button>
      </div>
      {task.status === "uploading" && (
        <div className="mt-2">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
            <div className="h-full rounded-full bg-emerald-600 transition-all" style={{ width: `${task.progress}%` }} />
          </div>
          <div className="mt-1 text-slate-500">Uploading… {task.progress}%</div>
        </div>
      )}
      {task.status !== "uploading" && task.message && <div className="mt-1">{task.message}</div>}
      {task.errors && task.errors.length > 0 && (
        <ul className="mt-2 max-h-40 list-disc space-y-0.5 overflow-y-auto pl-4">
          {task.errors.map((e, i) => (
            <li key={i}>
              <span className="font-medium">Row {e.row}:</span> {e.error}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
