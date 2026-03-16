export const dynamic = "force-dynamic";

import { RadioProvider } from "@/components/RadioProvider";
import { MediaProvider } from "@/components/MediaProvider";
import ContentArea from "@/components/ContentArea";
import AudioVisualizer from "@/components/AudioVisualizer";
import PlayButton from "@/components/RadioPlayer";
import NowPlaying from "@/components/NowPlaying";
import NewsTicker from "@/components/NewsTicker";
import ConnectingOverlay from "@/components/CallInModal";
import LiveCallPanel from "@/components/LiveCallPanel";
import SourceBar from "@/components/SourceBar";
import UpNext from "@/components/UpNext";
import UpNextWrapper from "@/components/UpNextWrapper";
import RadioHeader from "@/components/RadioHeader";
import AmbientGlow from "@/components/AmbientGlow";
import NewsImageOverlay from "@/components/NewsImageOverlay";

export default function Home() {
  return (
    <RadioProvider>
      <MediaProvider>
        <div className="min-h-screen bg-base text-text flex flex-col relative overflow-hidden">
          {/* Ambient background glow — station-colored */}
          <AmbientGlow />

          {/* Header — station-aware */}
          <RadioHeader />

          {/* Content area — shrinks when expanded panel is open */}
          <ContentArea>
            {/* Main */}
            <main className="relative z-10 flex-1 flex flex-col items-center justify-center px-4 py-6 gap-8">
              {/* Visualizer + Play button */}
              <div className="relative w-64 h-64 sm:w-80 sm:h-80 md:w-96 md:h-96 lg:w-105 lg:h-105">
                <AudioVisualizer />
                <div className="absolute inset-0 flex items-center justify-center">
                  <PlayButton />
                </div>
              </div>

              {/* Now playing info */}
              <NowPlaying />

              {/* Sources row */}
              <SourceBar />
            </main>

            {/* Up Next — floating sidebar on desktop, hidden when call expanded */}
            <UpNextWrapper>
              <UpNext />
            </UpNextWrapper>
          </ContentArea>

          {/* Ticker — always full width */}
          <NewsTicker />
        </div>

        {/* Call overlays */}
        <ConnectingOverlay />
        <LiveCallPanel />
        <NewsImageOverlay />
      </MediaProvider>
    </RadioProvider>
  );
}
