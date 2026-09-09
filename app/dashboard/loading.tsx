export default function Loading() {
  return (
    <div className="p-4 flex flex-col gap-6 w-full">
      <div className="flex items-center justify-between">
        <div className="h-8 bm-skeleton w-32 rounded-lg"></div>
        <div className="h-8 bm-skeleton w-10 rounded-full"></div>
      </div>
      <div className="h-24 bm-skeleton w-full rounded-2xl"></div>
      <div className="grid grid-cols-2 gap-4">
        <div className="h-24 bm-skeleton rounded-2xl"></div>
        <div className="h-24 bm-skeleton rounded-2xl"></div>
      </div>
      <div className="h-64 bm-skeleton w-full rounded-2xl"></div>
    </div>
  );
}
