import type { APIRoute } from "astro";
import { isCollectionCity } from "@/lib/collection";
import { cityScenes, getCityScenePayload } from "@/lib/photography-map";
import type { CityScenePayload } from "@/lib/photography-map/types";

type Props = { payload: CityScenePayload };

export function getStaticPaths() {
  return cityScenes
    .filter((city) => isCollectionCity(city.id))
    .map((city) => ({
      params: { city: city.id },
      props: { payload: getCityScenePayload(city.id) },
    }));
}

export const GET: APIRoute<Props> = ({ props }) =>
  new Response(JSON.stringify(props.payload), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=0, must-revalidate",
    },
  });
