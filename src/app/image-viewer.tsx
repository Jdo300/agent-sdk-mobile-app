import { ScrollView, StyleSheet, View, useWindowDimensions } from "react-native";
import { Image } from "expo-image";

import { Header, Screen } from "../components/ui/Screen";
import { Text } from "../components/ui/Text";
import { getViewerPayload } from "../lib/viewerPayload";
import { useTheme } from "../theme/ThemeProvider";

export default function ImageViewerScreen() {
  const payload = getViewerPayload();
  const uri = payload?.kind === "image" ? payload.uri : null;
  const alt = payload?.kind === "image" ? payload.alt : undefined;
  const headers = payload?.kind === "image" ? payload.headers : undefined;
  const { colors } = useTheme();
  const { width, height } = useWindowDimensions();

  return (
    <Screen>
      <Header title="Image" back />
      {uri ? (
        <ScrollView
          style={styles.zoom}
          contentContainerStyle={[styles.zoomContent, { minHeight: height - 100 }]}
          minimumZoomScale={1}
          maximumZoomScale={5}
          bouncesZoom
          centerContent
          showsHorizontalScrollIndicator={false}
          showsVerticalScrollIndicator={false}
        >
          <Image
            source={{ uri, ...(headers ? { headers } : {}) }}
            style={{ width, height: Math.max(300, height - 120), backgroundColor: colors.bg }}
            contentFit="contain"
            accessible={Boolean(alt)}
            accessibilityLabel={alt}
          />
        </ScrollView>
      ) : (
        <View style={styles.empty}><Text ink={2}>This image is no longer available.</Text></View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  zoom: { flex: 1 },
  zoomContent: { alignItems: "center", justifyContent: "center" },
  empty: { padding: 24 },
});
